'use strict';

const os = require('os');
const path = require('path');
const url = require('url');
const {assign, flatten, invokeMap, uniq} = require('lodash');
const penthouse = require('penthouse');
const CleanCSS = require('clean-css');
const filterCss = require('filter-css');
const oust = require('oust');
const postcss = require('postcss');
const imageInliner = require('postcss-image-inliner');
const Bluebird = require('bluebird');
const debug = require('debug')('critical:core');

const file = require('./file-helper');

/**
 * Returns a string of combined and deduped css rules.
 * @param cssArray
 * @returns {String}
 */
function combineCss(cssArray) {
    if (cssArray.length === 1) {
        return cssArray[0].toString();
    }

    return new CleanCSS({
        level: {
            1: {
                all: true
            },
            2: {
                all: false,
                removeDuplicateFontRules: true,
                removeDuplicateMediaBlocks: true,
                removeDuplicateRules: true,
                removeEmpty: true,
                mergeMedia: true
            }
        }
    }).minify(
        invokeMap(cssArray, 'toString').join(' ')
    ).styles;
}

/**
 * Append stylesheets to result
 * @param opts
 * @returns {function}
 */
function appendStylesheets(opts) {
    return htmlfile => {
        // Consider opts.css and map to array if it isn't one
        if (opts.css) {
            const css = Array.isArray(opts.css) ? opts.css : [opts.css];
            return Bluebird.map(css, stylesheet => file.assertLocal(stylesheet, opts)).then(stylesheets => {
                htmlfile.stylesheets = stylesheets;
                return htmlfile;
            });
        }

        // Oust extracts a list of your stylesheets
        let stylesheets = flatten([
            oust.raw(htmlfile.contents.toString(), 'stylesheets'),
            oust.raw(htmlfile.contents.toString(), 'preload')
        ]).filter(link => link.$el.attr('media') !== 'print' && Boolean(link.value)).map(link => link.value);

        stylesheets = uniq(stylesheets).map(file.resourcePath(htmlfile, opts));
        debug('appendStylesheets', stylesheets);

        if (stylesheets.length === 0) {
            return Promise.reject(new Error('No usable stylesheets found in html source. Try to specify the stylesheets manually.'));
        }

        return Bluebird.map(stylesheets, stylesheet => file.assertLocal(stylesheet, opts)).then(stylesheets => {
            htmlfile.stylesheets = stylesheets;
            return htmlfile;
        });
    };
}

/**
 * Inline images using postcss-image-inliner
 * @param opts
 * @returns {function}
 */
function inlineImages(opts) {
    return vinyl => {
        if (opts.inlineImages) {
            const assetPaths = opts.assetPaths || [];

            // Add some suitable fallbacks for convinience if nothing is set.
            // Otherwise don't add them to keep the user in control
            if (assetPaths.length === 0) {
                assetPaths.push(path.dirname(vinyl.path));
                // Add domain as asset source for external domains
                if (file.isExternal(opts.src)) {
                    // eslint-disable-next-line node/no-deprecated-api
                    const urlObj = url.parse(opts.src);
                    const domain = `${urlObj.protocol}//${urlObj.host}`;
                    assetPaths.push(domain, domain + path.dirname(urlObj.pathname));
                }

                if (opts.base) {
                    assetPaths.push(opts.base);
                }
            }

            const inlineOptions = {
                assetPaths: uniq(assetPaths),
                maxFileSize: opts.maxImageFileSize || 10240
            };
            debug('inlineImages', inlineOptions);
            return postcss([imageInliner(inlineOptions)])
                .process(vinyl.contents.toString('utf8'), {from: undefined})
                .then(contents => {
                    vinyl.contents = Buffer.from(contents.css);
                    return vinyl;
                });
        }

        return vinyl;
    };
}

/**
 * Helper function create vinyl objects
 * @param opts
 * @returns {function}
 */
function vinylize(opts) {
    return filepath => {
        if (filepath._isVinyl) {
            return filepath;
        }

        debug('vinylize', path.resolve(filepath));
        return file.getVinylPromise({
            src: path.resolve(filepath),
            base: opts.base
        });
    };
}

/**
 * Read css source, inline images and normalize relative paths
 * @param opts
 * @returns {function}
 */
function processStylesheets(opts) {
    return htmlfile => {
        debug('processStylesheets', htmlfile.stylesheets);
        return Bluebird.map(htmlfile.stylesheets, vinylize(opts))
            .map(inlineImages(opts))
            .map(file.replaceAssetPaths(htmlfile, opts))
            .reduce((total, stylesheet) => {
                return total + os.EOL + stylesheet.contents.toString('utf8');
            }, '')
            .then(css => {
                htmlfile.cssString = css;
                return htmlfile;
            });
    };
}

/**
 * Fire up a server as pentouse doesn't like filesystem paths on windows
 * and let pentouse compute the critical css for us
 * @param dimensions
 * @param {object} opts Options passed to critical
 * @returns {function}
 */
function computeCritical(dimensions, opts) {
    return htmlfile => {
        debug(`Processing: ${htmlfile.path} [${dimensions.width}x${dimensions.height}]`);
        const penthouseOpts = assign({}, opts.penthouse, {
            url: file.getPenthouseUrl(opts, htmlfile),
            cssString: htmlfile.cssString,
            width: dimensions.width,
            height: dimensions.height,
            userAgent: opts.userAgent
        });

        if (opts.user && opts.pass) {
            penthouseOpts.customPageHeaders = {Authorization: `Basic ${file.token(opts.user, opts.pass)}`};
        }

        return penthouse(penthouseOpts);
    };
}

/**
 * Critical path CSS generation
 * @param  {object} opts Options
 * @accepts src, base, width, height, dimensions, dest
 * @return {Promise}
 */
function generate(opts) {
    const cleanCSS = new CleanCSS();
    opts = opts || {};

    if (!opts.src && !opts.html) {
        return Bluebird.reject(new Error('A valid source is required.'));
    }

    if (!opts.dimensions) {
        opts.dimensions = [{
            height: opts.height || 900,
            width: opts.width || 1300
        }];
    }

    debug('Start with the following options');
    debug(opts);

    return Bluebird.map(opts.dimensions, dimensions => {
        // Use content to fetch used css files
        return file.getVinylPromise(opts)
            .then(appendStylesheets(opts))
            .then(processStylesheets(opts))
            .then(computeCritical(dimensions, opts));
    }).then(criticalCSS => {
        criticalCSS = combineCss(criticalCSS);

        if (opts.ignore) {
            debug('generate', 'Applying filter', opts.ignore);
            criticalCSS = filterCss(criticalCSS, opts.ignore, opts.ignoreOptions || {});
        }

        debug('generate', 'Minify css');
        criticalCSS = cleanCSS.minify(criticalCSS).styles;

        debug('generate', 'Done');
        return criticalCSS;
    }).catch(error => {
        if (error.message.startsWith('PAGE_UNLOADED_DURING_EXECUTION')) {
            return '';
        }

        return Promise.reject(error);
    });
}

exports.appendStylesheets = appendStylesheets;
exports.generate = generate;
