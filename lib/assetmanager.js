/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

(function () {
    "use strict";

    var util = require("util"),
        path = require("path"),
        EventEmitter = require("events").EventEmitter;

    var analysis = require("./analysis"),
        FileManager = require("./filemanager");

    var _componentIdCounter = 0;

    // The asset manager maintains a set of assets for a given document. On initialization,
    // it parses the layers' names into a set of components, requests renderings of each of
    // those components from the render manager, and organizes the rendered assets into the
    // appropriate files and folders. When the document changes, it requests that the appropriate
    // components be re-rendered or moved into the right place. It also manages error reporting.

    function AssetManager(generator, document, renderManager) {
        this._generator = generator;
        this._document = document;
        this._renderManager = renderManager;

        this._fileManager = new FileManager();
        this._handleChange = this._handleChange.bind(this);
    }

    util.inherits(AssetManager, EventEmitter);

    AssetManager.prototype._baseDirectory = null;

    AssetManager.prototype._allComponents = null;

    AssetManager.prototype._componentsForLayer = null;

    AssetManager.prototype._layerForComponent = null;

    AssetManager.prototype._renderPromises = null;

    AssetManager.prototype._reset = function () {
        this._allComponents = {};
        this._renderPromises = {};
        this._layerForComponent = {};
        this._componentsForLayer = {};
        this._fileManager.setBasePath(this._document.file);

        this._document.layers.visit(function (layer) {
            // Don't visit the top-level LayerGroup
            if (layer.group) {
                var results = analysis.analyzeLayerName(layer.name);

                results.forEach(function (result) {
                    var component = result.component,
                        componentId;

                    if (component.file) {
                        componentId = this._addComponent(layer.id, component);
                        this._requestRender(componentId);
                    }
                    // TODO report errors
                }, this);
            }
        }.bind(this));
    };

    AssetManager.prototype._getAssetPath = function (component) {
        if (component.folder) {
            return path.resolve(component.folder, component.file);
        } else {
            return component.file;
        }
    };

    AssetManager.prototype._requestRender = function (componentId) {
        var component = this._allComponents[componentId],
            document = this._document,
            layerId = this._layerForComponent[componentId],
            layer = document.layers.findLayer(layerId).layer;

        // FIXME: the document and layer might need to be cloned so that they
        // don't change in the middle of rendering
        var renderPromise = this._renderManager.render(document, layer, component, componentId);

        this._renderPromises[componentId] = renderPromise;

        renderPromise
            .then(this._handleRenderResponse.bind(this, componentId))
            .fail(this._handleRenderFailure.bind(this, componentId))
            .finally(function () {
                delete this._renderPromises[componentId];
            }.bind(this))
            .done();
    };

    AssetManager.prototype._cancelRender = function (componentId) {
        this._renderManager.cancel(componentId);
    };

    AssetManager.prototype._hasPendingRender = function (componentId) {
        if (this._renderPromises.hasOwnProperty(componentId)) {
            var promise = this._renderDeferreds[componentId];

            if (promise.inspect().state === "pending") {
                return true;
            }
        }

        return false;
    };

    AssetManager.prototype._addComponent = function (layerId, component) {
        var componentId = _componentIdCounter++;

        this._allComponents[componentId] = component;
        this._layerForComponent[componentId] = layerId;

        if (!this._componentsForLayer.hasOwnProperty(layerId)) {
            this._componentsForLayer[layerId] = {};
        }

        this._componentsForLayer[layerId][componentId] = true;

        return componentId;
    };

    AssetManager.prototype._removeComponent = function (componentId) {
        var layerId = this._layerForComponent[componentId];

        delete this._layerForComponent[componentId];
        delete this._componentsForLayer[layerId][componentId];

        if (Object.keys(this._componentsForLayer[layerId]).length === 0) {
            delete this._componentsForLayer[layerId];
        }

        delete this._allComponents[componentId];
    };

    AssetManager.prototype._removeAllComponents = function (layerId) {
        Object.keys(this._componentsForLayer[layerId]).forEach(function (componentId) {
            this._removeComponent(componentId);
        }, this);
    };

    AssetManager.prototype._handleRenderResponse = function (componentId, tmpPath) {
        if (tmpPath) {
            var component = this._allComponents[componentId],
                assetPath = this._getAssetPath(component);

            if (!assetPath) {
                // FIXME: test this before rending the asset
                this._fileManager.removeFileAbsolute(tmpPath);
            } else {
                this._fileManager.moveFileInto(tmpPath, assetPath);
            }    
        }
    };

    AssetManager.prototype._handleRenderFailure = function (componentId, err) {
        var layerId = this._layerForComponent[componentId],
            component = this._allComponents[componentId];

        if (err) {
            console.warn("Failed to render component %d for layer %d: %s", componentId, layerId, err.stack);
        } else {
            console.log("Canceled render of component '%s' for layer %d", component.name, layerId);
        }
    };

    /**
     * Handle the document's change events. If the document is closed, finish
     * processing. If layers are changed, reparse those layers and their
     * dependencies to into components, and add the layer ids to the work set.
     */
    AssetManager.prototype._handleChange = function (change) {
        console.log("handleChange:", change);

        function getDependentLayers(layer) {
            // If it's an adjustment layer, everything below the current position and 
            // everything below the previous position. For now, just add all the parents.
            var dependencies = layer.name ? [layer] : [];

            if (layer.group) {
                dependencies = dependencies.concat(getDependentLayers(layer.group));
            }

            return dependencies;
        }

        // if the layer was just renamed; then reparse it and figure out if component
        // settings have changed; if so, add it to the work set; otherwise, just
        // fire off any relevant rename events;

        if (change.layers) {
            var changedLayerIds = Object.keys(change.layers).map(function (key) {
                return parseInt(key, 10);
            }),
                changedLayerComponents = {};

            // Compute the set of all changed layers and their dependencies;
            // parse the new layers into components
            changedLayerIds.forEach(function (id) {
                var layerChange = change.layers[id],
                    layer = layerChange.layer,
                    dependentLayers = getDependentLayers(layer);
                
                console.log("Layers dependent on %d: %s", layer.id, dependentLayers);
                dependentLayers.forEach(function (layer) {
                    var components = analysis.analyzeLayerName(layer.name);

                    changedLayerComponents[layer.id] = components.reduce(function (components, componentRec) {
                        var component = componentRec.component,
                            errors = componentRec.errors;

                        if (component.file) {
                            console.log("Found changed component for layer %d: %s", layer.id, component.file);
                            components.push(component);
                        } else {
                            console.warn("Skipping component: ", component.name, errors);
                        }

                        return components;
                    }.bind(this), []);
                }, this);
            }, this);

            // Compute the set of removed layers;
            // subtract the removed layers from the set of changed layers above 
            var removedLayerIds = changedLayerIds.filter(function (id) {
                var layerChange = change.layers[id];
                if (layerChange.type === "removed") {
                    if (changedLayerComponents.hasOwnProperty(id)) {
                        delete changedLayerComponents[id];
                    }
                    return true;
                }
            }, this);

            // Clear out the removed layer components;
            // remove the assets from the old components and/or cancel their renders
            removedLayerIds.forEach(function (layerId) {
                Object.keys(this._componentsForLayer[layerId])
                    .map(function (key) {
                        return parseInt(key, 10);
                    })
                    .forEach(function (componentId) {
                        var component = this._allComponents[componentId],
                            assetPath = this._getAssetPath(component);

                        if (this._hasPendingRender(componentId)) {
                            this._cancelRender(componentId);
                        }
                        this._removeComponent(componentId);
                        this._fileManager.removeFileWithin(assetPath);
                    }, this);
            }, this);

            // Update the changed layer components, requesting new assets as appropriate 
            Object.keys(changedLayerComponents).map(function (key) {
                return parseInt(key, 10);
            }).forEach(function (layerId) {
                var components = changedLayerComponents[layerId];

                components.forEach(function (component) {
                    var componentId = this._addComponent(layerId, component);
                    this._requestRender(componentId);
                }, this);
            }, this);
        }

        if (change.file) {
            this._fileManager.setBasePath(this._document.file);
        }
    };

    AssetManager.prototype.unpause = function () {
        this._document.on("change", this._handleChange);
        this._reset();
    };

    AssetManager.prototype.pause = function () {
        this._document.off("change", this._handleChange);

        this._renderManager.cancelAll(this._document.id);

        this._renderDeferreds.forEach(function (componentId) {
            this._cancelRender(componentId);
        }, this);
    };
    

    module.exports = AssetManager;
}());