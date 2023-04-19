/* global BUILD_TIMESTAMP */

import $ from 'jquery';
import _ from 'underscore';
// Import hammerjs for geojs touch events
import Hammer from 'hammerjs';
import d3 from 'd3';

import {restRequest} from '@girder/core/rest';

import ImageViewerWidget from './base';
import setFrameQuad from './setFrameQuad.js';

window.hammerjs = Hammer;
window.d3 = d3;

var GeojsImageViewerWidget = ImageViewerWidget.extend({
    initialize: function (settings) {
        this._scale = settings.scale;
        this._setFrames = settings.setFrames;

        let root = '/static/built';
        try {
            root = __webpack_public_path__ || root; // eslint-disable-line
        } catch (err) { }
        root = root.replace(/\/$/, '');
        $.when(
            ImageViewerWidget.prototype.initialize.call(this, settings).then(() => {
                if (this.metadata.geospatial) {
                    this.tileWidth = this.tileHeight = null;
                    return restRequest({
                        type: 'GET',
                        url: 'item/' + this.itemId + '/tiles',
                        data: {projection: 'EPSG:3857'}
                    }).done((resp) => {
                        this.levels = resp.levels;
                        this.tileWidth = resp.tileWidth;
                        this.tileHeight = resp.tileHeight;
                        this.sizeX = resp.sizeX;
                        this.sizeY = resp.sizeY;
                        this.metadata = resp;
                    });
                }
                return this;
            }),
            $.ajax({ // like $.getScript, but allow caching
                url: root + '/plugins/large_image/extra/geojs.js' + (BUILD_TIMESTAMP ? '?_=' + BUILD_TIMESTAMP : ''),
                dataType: 'script',
                cache: true
            }))
            .done(() => {
                this.trigger('g:beforeFirstRender', this);
                this.render();
            });
    },

    render: function () {
        // If script or metadata isn't loaded, then abort
        if (!window.geo || !this.tileWidth || !this.tileHeight || this.deleted) {
            return this;
        }

        if (this.viewer) {
            // don't rerender the viewer
            return this;
        }

        var geo = window.geo; // this makes the style checker happy

        var params = {
            useCredentials: true,
            autoshareRenderer: false,
            attribution: null,
            maxLevel: this.levels - 1
        };
        if (this.tileWidth > 8192 || this.tileHeight > 8192) {
            params.renderer = 'canvas';
        }
        if (this.metadata.geospatial && this.metadata.bounds) {
            params.keepLower = false;
            params.url = this._getTileUrl('{z}', '{x}', '{y}', {encoding: 'PNG', projection: 'EPSG:3857'});
            this.viewer = geo.map({node: this.el, max: this.levels - 1});
            this._bottomLayer = this.viewer.createLayer('osm');
            if (this.metadata.bounds.xmin !== this.metadata.bounds.xmax && this.metadata.bounds.ymin !== this.metadata.bounds.ymax) {
                this.viewer.bounds({
                    left: this.metadata.bounds.xmin,
                    right: this.metadata.bounds.xmax,
                    top: this.metadata.bounds.ymax,
                    bottom: this.metadata.bounds.ymin
                }, 'EPSG:3857');
            }
        } else {
            params.url = this._getTileUrl('{z}', '{x}', '{y}');
            var {map, layer} = geo.util.pixelCoordinateParams(
                this.el, this.sizeX, this.sizeY, this.tileWidth, this.tileHeight
            );
            params = Object.assign({}, params, layer);
            this.viewer = geo.map(map);
        }
        this._layer = this.viewer.createLayer('osm', params);

        const baseUrl = this._getTileUrl('{z}', '{x}', '{y}');
        const match = baseUrl.match(/[?&](_=[^&]*)/);
        const updated = match && match[1] ? ('&' + match[1]) : '';
        setFrameQuad(this.metadata, this._layer, {
            // allow more and larger textures is slower, balancing
            // performance and appearance
            // maxTextures: 16,
            // maxTotalTexturePixels: 256 * 1024 * 1024,
            baseUrl: baseUrl.split('/tiles/')[0] + '/tiles',
            restRequest: restRequest,
            restUrl: 'item/' + this.itemId + '/tiles',
            query: 'cache=true' + updated
        });
        this._layer.setFrameQuad(0);
        if (this._setFrames) {
            this._setFrames(this.metadata, _.bind(this.frameUpdate, this));
        }
        if (this._scale && (this.metadata.mm_x || this.metadata.geospatial || this._scale.scale)) {
            if (!this._scale.scale && !this.metadata.geospatial) {
                // convert mm to m.
                this._scale.scale = this.metadata.mm_x / 1000;
            }
            this.uiLayer = this.viewer.createLayer('ui');
            this.scaleWidget = this.uiLayer.createWidget('scale', this._scale);
        }

        this._postRender();

        this.trigger('g:imageRendered', this);
        return this;
    },

    /**
     * Extensible code that will be run after rendering but before the render
     * trigger.
     */
    _postRender: function () {
    },

    frameUpdate: function (frame, style) {
        if (this._frame === undefined) {
            // don't set up layers until the we access the first non-zero frame
            if (frame === 0 && style === undefined) {
                return;
            }
            this._frame = 0;
            this._style = undefined;
            this._baseurl = this._layer.url();
            // use two layers to get smooth transitions until we load
            // background quads.  Always cteate this, as styles will use
            // this, even if pure frame do not.
            this._layer2 = this.viewer.createLayer('osm', this._layer._options);
            this._layer2.moveDown();
            setFrameQuad((this._layer.setFrameQuad.status || {}).tileinfo, this._layer2, (this._layer.setFrameQuad.status || {}).options);
            this._layer2.setFrameQuad(0);
        }
        frame = frame || 0;
        this._nextframe = frame;
        this._nextstyle = style;
        if ((frame !== this._frame || style !== this._style) && !this._updating) {
            this._frame = frame;
            this._style = style;
            this.trigger('g:imageFrameChanging', this, frame);
            const quadLoaded = ((this._layer.setFrameQuad || {}).status || {}).loaded;
            if (quadLoaded && this._style === undefined) {
                this._layer.url(this.getFrameAndUrl().url);
                this._layer.setFrameQuad(frame);
                this._layer.frame = frame;
                this.trigger('g:imageFrameChanged', this, frame);
                return;
            }
            if (this._layer.frame !== undefined) {
                this._layer.setFrameQuad(undefined);
                this._layer.frame = undefined;
            }
            this._updating = true;
            this.viewer.onIdle(() => {
                this._layer2.url(this.getFrameAndUrl().url);
                if (this._style === undefined) {
                    this._layer2.setFrameQuad(frame);
                    this._layer2.frame = frame;
                } else {
                    this._layer2.setFrameQuad(undefined);
                    this._layer2.frame = undefined;
                }
                this.viewer.onIdle(() => {
                    this._layer.moveDown();
                    if (this._bottomLayer) this._bottomLayer.moveDown();
                    var ltemp = this._layer;
                    this._layer = this._layer2;
                    this._layer2 = ltemp;
                    this._updating = false;
                    this.trigger('g:imageFrameChanged', this, frame);
                    if (frame !== this._nextframe || style !== this._nextstyle) {
                        this.frameUpdate(this._nextframe, this._nextstyle);
                    }
                });
            });
        }
    },

    getFrameAndUrl: function () {
        let frame = this._frame || 0;
        let url = this._baseurl || this._layer.url();
        // setting the frame to the first frame used in a style seems to
        // resolve a caching issue, which is probably a bug in the styling
        // functions.  Until that is resolved, we do this.
        if (this._style && this._style.bands && !this._style.bands.some((b) => b.frame === undefined) && this._style.bands.length) {
            frame = this._style.bands[0].frame;
        }
        if (frame) {
            url += (url.indexOf('?') >= 0 ? '&' : '?') + 'frame=' + frame;
        }
        if (this._style !== undefined) {
            const encodedStyle = encodeURIComponent(JSON.stringify(this._style));
            url += (url.indexOf('?') >= 0 ? '&' : '?') + 'style=' + encodedStyle;
        }
        return {
            frame: frame,
            style: this._style,
            url: url
        };
    },

    destroy: function () {
        if (this.viewer) {
            // make sure there is nothing left in the animation queue
            var queue = [];
            this.viewer.animationQueue(queue);
            queue.splice(0, queue.length);
            this.viewer.exit();
            this.viewer = null;
        }
        this.deleted = true;
        ImageViewerWidget.prototype.destroy.call(this);
    }
});

export default GeojsImageViewerWidget;
