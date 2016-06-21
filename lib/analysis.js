var tern = require('tern');
var path = require('path');
var fs = require('fs');
var url = require('url');

var walk = require('acorn/dist/walk');

var FastSet = require("collections/fast-set");

var plugin = require('./tern-def-api.js');
var scope = require('./define-path-info.js');
var util = require('./util.js');
var logger = require('./logger.js');
var format = require('./type-format.js');

require('./reactjs.js');

require('tern/plugin/doc_comment');
require('tern/plugin/commonjs');
require('tern/plugin/modules');
require('tern/plugin/node');
require('tern/plugin/node_resolve');

//require('tern/plugin/requirejs');

var localDir = process.cwd();
var ternServer = null;

var localFiles = null;

var allIdents = 0;
var undefinedIdents = 0;

var out = {
    Defs: new FastSet([], function(a, b) {
        return a.Path == b.Path;
    }, function(o) {
        return o.Path;
    }),
    Refs: new FastSet([], function(a, b) {
        return a.DefPath == b.DefPath &&
               a.DefUnitType == b.DefUnitType &&
               a.DefRepo == b.DefRepo &&
               a.Def == b.Def &&
               a.File == b.File &&
               a.Start == b.Start &&
               a.End == b.End;
    }, function(o) {
        return [o.DefPath, o.DefUnitType, o.DefRepo, o.Def, o.File, o.Start, o.End].join("|");
    }),
    Docs: new FastSet([], function(a, b) {
        return a.Path == b.Path;
    }, function(o) {
        return o.Path;
    })
};

initTernServer(process.argv.slice(2).map(function(file) {
    return util.normalizePath(file);
}));
out.Defs = out.Defs.toArray();
out.Refs = out.Refs.toArray();
out.Docs = out.Docs.toArray();
console.log(JSON.stringify(out, null, 2));

function initTernServer(files) {
    localFiles = files;
    var defsPath = path.join(__dirname, "../node_modules/tern/defs/ecma5.json");
    var defs = JSON.parse(fs.readFileSync(defsPath, "utf8"));
    var browserDefsPath = path.join(__dirname, "../node_modules/tern/defs/browser.json");
    var browserDefs = JSON.parse(fs.readFileSync(browserDefsPath, "utf8"));
    var ternOptions = {
        dependencyBudget: 500000,
        projectDir: localDir,
        defs: [defs, browserDefs],
        async: false,
        getFile: function(file) {
            return fs.readFileSync(path.resolve(localDir, file), "utf8");
        },
        plugins: {
            node: true,
            requirejs: true,
            modules: true,
            es_modules: true,
            commonjs: true,
            doc_comment: true,
            reactjs: true
        }
    };

    ternServer = new tern.Server(ternOptions);

    files.forEach(function(file) {
        ternServer.addFile(file);
    });

    ternServer.flush(function(err) {
        if (err) throw err;
        scope.initLocalFilesScopePaths(ternServer, localFiles);
        analyseAll();
    });

    logger.info("Analysed %d identifiers, %d are not resolved (%d%%)", allIdents, undefinedIdents, (undefinedIdents / Math.max(allIdents, 1)) * 100);

    return out;
}

function getQueryInfo(file, offset, type, start) {
    var query = {
        type: type,
        start: start,
        end: offset,
        file: file,
        docFormat: "full"
    };

    var res = null;
    ternServer.request({
        query: query,
        offset: offset
    }, function(error, data) {
        if (error) {
            logger.warn("Tern server returned an error [type: %s, start: %d, end: %d, file: %s]: %s", type, start, offset, file, error);
            return;
        }
        res = data;
    });
    return res;
}

function getType(file, offset, start) {
    return getQueryInfo(file, offset, "type", start);
}

/**
 * 
 * @param {string} file reference's file 
 * @param {number} end end offset
 * @param {number} start start offset
 * @return {Object} definition that ref located in given file at the following span refers to 
 * 
 */
function getDefinition(file, end, start) {
    var query = {
        type: "definition",
        start: start,
        end: end,
        file: file.name,
        docFormat: "full"
    };
    return plugin.findDef(ternServer, query, file);
}

function getCompletions(file, offset, start) {
    return getQueryInfo(file, offset, "completions", start);
}

function getDocumentation(file, offset, start) {
    return getQueryInfo(file, offset, "documentation", start);
}

function formPathFromId(id) {
    return util.formPath(id.sourceFile.name, id.start, id.end);
}

function formPathFromData(data, externalRepo) {
    if (data === null) {
        return null;
    }
    if (externalRepo === null) {
        if (data.origin === undefined || data.start === undefined || data.end === undefined) {
            return null;
        } else {
            return util.formPath(data.origin, data.start, data.end);
        }
    } else {
        return util.formPath(externalRepo.filePath, data.start, data.end);
    }
}

//form module path for external modules, modules with 'node_modules' in path
function formPathForModule(externalRepo) {
    var res = externalRepo.filePath.split("/");
    res[0] = "module";
    return res.join("/");
}

// TODO refactor this method, bad approach for finding package.json
function getExternalRepoInfo(data) {
    if (!data || !data.origin) {
        return null;
    }

    if (["node", "commonjs", "ecma5"].indexOf(data.origin) >= 0) {
        return null;
    }

    var filePath = util.normalizePath(data.origin);

    if (localFiles.indexOf(filePath) > -1) {
        return null;
    }

    // node_modules/... or .../node_modules/...
    var pos = filePath.indexOf("node_modules/");
    if (pos < 0 || pos > 0 && filePath.charAt(pos - 1) != "/") {
        return null;
    }

    var prefix = filePath.substring(0, pos);
    var suffix = filePath.substring(pos + "node_modules/".length);

    var pathRes = suffix.split("/");
    var dirPath = path.join(prefix,  "node_modules", pathRes[0]);

    //checking whether path contains directory after node_modules
    if (fs.lstatSync(dirPath).isDirectory()) {
        var packageJsonPath = path.join(prefix, "node_modules", pathRes[0], "package.json");
    } else {
        var packageJsonPath = path.join(prefix, "node_modules", "package.json");
    }

    //check whether package.json file exists in the determined path
    try {
        fs.statSync(packageJsonPath);
    } catch (e) {
        return null;
    }

    var json = fs.readFileSync(packageJsonPath);
    var packageJson = JSON.parse(json.toString());

    if (!packageJson.repository) {
        logger.debug("No repository defined in", packageJsonPath);
        return null;
    }

    return {
        repo: packageJson.repository.url,
        unit: pathRes[0],
        filePath: suffix
    };
}

function initNodeInfo(kind, typeInfo) {
    var nodeKind = kind || '';
    var nodeTypeInfo = typeInfo || '';

    return {
        kind: nodeKind,
        typeInfo: nodeTypeInfo
    };
}

function analyseAll() {

    // current class name
    var currentClass = null;

    var searchVisitor = walk.make({
        Function: function(node, nodeInfo, c) {
            var params = node.params.map(function(param) {
                // handling rest parameters
                return param.argument || param;
            });
            if (node.id) {
                var paramNames = params.map(function(param) {
                    return param.name;
                });
                c(node.id, initNodeInfo("function", "(" + paramNames.join(", ") + ")"));
            }
            params.forEach(function(param) {
                c(param, initNodeInfo("param"));
            });
            c(node.body, initNodeInfo("fn_body"));
        },

        // TryStatement: function(node, st, c) {
        //     if (node.handler)
        //         c(node.handler.param, st);
        //     walk.base.TryStatement(node, st, c);

        // },

        VariableDeclaration: function(node, nodeInfo, c) {
            for (var i = 0; i < node.declarations.length; ++i) {
                var decl = node.declarations[i];
                c(decl.id, initNodeInfo(node.kind));
                if (decl.init) {
                    c(decl.init, initNodeInfo("var_init"));
                }
            }
        },
        MemberExpression: function(node, nodeInfo, c) {
            c(node.object, initNodeInfo("object instance"));
            c(node.property, initNodeInfo("property"));
        },
        ObjectExpression: function(node, nodeInfo, c) {
            node.properties.forEach(function(property) {
                c(property.value, initNodeInfo("object value"));
                c(property.key, initNodeInfo(property.value.type == "FunctionExpression" ?
                    "function" :
                    "object property"));
            });
        },
        CallExpression: function(node, kind, c) {
            //Provides jump to modules while hovering on literal in require statement
            if (node.callee.name === 'require') {
                var args = node.arguments;
                var data = getDefinition(node.sourceFile, args[0].end, args[0].start);
                var externalRepo = getExternalRepoInfo(data);

                //Emission of refs for external modules, modules from node_modules
                if (externalRepo) {
                    var ref = {
                        DefPath: formPathForModule(externalRepo),
                        Def: false,
                        File: node.sourceFile.name,
                        Start: args[0].start,
                        End: args[0].end
                    }
                    ref.DefRepo = externalRepo.repo;
                    ref.DefUnit = externalRepo.unit;
                    out.Refs.add(ref);
                } else {
                    //Emission of simple module refs - for local files
                    if (data.origin && data.origin !== "node" && data.origin !== "commonjs" && data.origin !== "ecma5") {
                        var ref = {
                            DefPath: "module/" + data.origin,
                            Def: false,
                            File: node.sourceFile.name,
                            Start: args[0].start,
                            End: args[0].end
                        }
                        out.Refs.add(ref);
                    } else {
                        //Emission of standard common module refs - commomjs, ecma5...
                        if (data.url) {
                            var urlStruct = url.parse(data.url);
                            var urlRef = {
                                DefPath: data.url,
                                DefUnitType: "URL",
                                DefRepo: urlStruct.protocol + (urlStruct.slashes ? "//" : "") + urlStruct.host,
                                Def: false,
                                File: node.sourceFile.name,
                                Start: args[0].start,
                                End: args[0].end
                            }
                            out.Refs.add(urlRef);
                        }
                    }
                }
            }
            c(node.callee, kind);
            for (var i = 0; i < node.arguments.length; i++) {
                c(node.arguments[i], kind);
            }
        },
        Identifier: function(node, nodeInfo, c) {

            // skipping dummy identifiers
            //  ✖ marks the spot, ternjs/acorn uses it to mark dummy nodes
            if (node.name == "✖") {
                return;
            }
            processIdent(node, nodeInfo, node.name);
        },
        Super: function(node, nodeInfo, c) {
            allIdents++;
            if (!currentClass) {
                undefinedIdents++;
                logger.info("Unresolved 'super' (no class name) [%d-%d] in %s", node.start, node.end, node.sourceFile.name);
                return;
            }
            var classDef = scope.getClass(currentClass);
            if (!classDef || !classDef.parent) {
                logger.info("Unresolved 'super' (no context) [%d-%d] in %s", node.start, node.end, node.sourceFile.name);
                undefinedIdents++;
                return;
            }
            classDef = scope.getClass(classDef.parent);
            if (!classDef) {
                logger.info("Unresolved 'super' (no parent context) [%d-%d] in %s", node.start, node.end, node.sourceFile.name);
                undefinedIdents++;
                return;
            }
            var ref = {
                DefPath: classDef.path,
                Def: false,
                File: node.sourceFile.name,
                Start: node.start,
                End: node.end
            };
            out.Refs.add(ref);

        },
        ThisExpression: function(node, nodeInfo, c) {
            allIdents++;
            if (!currentClass) {
                logger.info("Unresolved 'this' (no class name) [%d-%d] in %s", node.start, node.end, node.sourceFile.name);
                undefinedIdents++;
                return;
            }
            var classDef = scope.getClass(currentClass);
            if (!classDef) {
                logger.info("Unresolved 'this' (no context) [%d-%d] in %s", node.start, node.end, node.sourceFile.name);
                undefinedIdents++;
                return;
            }

            var ref = {
                DefPath: classDef.path,
                Def: false,
                File: node.sourceFile.name,
                Start: node.start,
                End: node.end
            };
            out.Refs.add(ref);
        },
        ClassDeclaration: function(node, nodeInfo, c) {
            if (node.id) {
                c(node.id, initNodeInfo("class"));
                currentClass = node.id.name;
            }
            if (node.superClass) {
                c(node.superClass, initNodeInfo("class"));
            }
            for (var i = 0; i < node.body.body.length; i++) {
                c(node.body.body[i], initNodeInfo("class_body"));
            }
            currentClass = null;
        },
        MethodDefinition: function(node, nodeInfo, c) {
            if (node.kind == 'constructor') {
                allIdents++;
                if (!currentClass) {
                    logger.info("Unresolved 'construct' (no class name) [%d-%d] in %s", node.start, node.end, node.sourceFile.name);
                    undefinedIdents++;
                    return;
                }
                var classDef = scope.getClass(currentClass);
                if (!classDef) {
                    logger.info("Unresolved 'construct' (no context) [%d-%d] in %s", node.start, node.end, node.sourceFile.name);
                    undefinedIdents++;
                    return;
                }

                var ref = {
                    DefPath: classDef.path,
                    Def: false,
                    File: node.sourceFile.name,
                    Start: node.key.start,
                    End: node.key.end
                };
                out.Refs.add(ref);
            } else {
                if (node.key) {
                    c(node.key, initNodeInfo("function"));
                }
            }
            c(node.value);
        },
        JSXElement: function(node, state, cb) {
            processIdent(node, state, node.openingElement.name.name);
            walk.base.JSXElement(node, state, cb);
        }
    });

    ternServer.files.forEach(function(file) {
        if (!/(^|\/)node_modules\//.exec(file.name)) {
            logger.info("Processing", file.name);
            walk.recursive(file.ast, initNodeInfo("ast"), null, searchVisitor);

            //add definition for each file-module representation and fake ref
            var kind = "module";
            var name = file.name;
            var defPath = kind + "/" + name;
            var defData = {
                Type: kind,
                Keyword: kind,
                Kind: kind,
                Separator: " "
            };
            var def = {
                Path: defPath,
                Name: name,
                Kind: kind,
                File: name,
                DefStart: file.ast.start,
                Data: defData
            };
            out.Defs.add(def);

            // Emit fake reference
            var ref = {
                DefPath: defPath,
                Def: true,
                File: name,
                Start: file.ast.start
            };
            out.Refs.add(ref);

            // console.error("AST = ", file.ast.body);
        }
    });
}

function processIdent(node, nodeInfo, name) {

    allIdents = allIdents + 1;
    var pathForId = formPathFromId(node);
    var data = getDefinition(node.sourceFile, node.end, node.start);
    var externalRepo = getExternalRepoInfo(data);

    var typeInfo = getType(node.sourceFile.name, node.end, node.start);
    var documentation = getDocumentation(node.sourceFile.name, node.end, node.start);
    var pathForDef = formPathFromData(data, externalRepo);

    if (!data || !pathForDef && !data.url) {
        undefinedIdents = undefinedIdents + 1;
        logger.info("Unresolved %s [%d-%d] in %s", name, node.start, node.end, node.sourceFile.name);
        return;
    }

    if (pathForDef === null && data.url !== undefined && nodeInfo.kind !== "var") {
        // Emit refs to environment variables
        var urlStruct = url.parse(data.url);
        var envRef = {
            DefPath: data.url,
            DefUnitType: "URL",
            DefRepo: urlStruct.protocol + (urlStruct.slashes ? "//" : "") + urlStruct.host,
            Def: false,
            File: node.sourceFile.name,
            Start: node.start,
            End: node.end
        };
        out.Refs.add(envRef);
        return;
    }

    if (pathForDef === pathForId || ((nodeInfo.kind === "var") && (pathForDef !== pathForId))) {
        // Emit definition
        var scopePathForId = scope.mapLinesPathToScopePath(ternServer, {
            file: node.sourceFile.name,
            start: node.start,
            end: node.end
        });
        if (!scopePathForId) {
            undefinedIdents = undefinedIdents + 1;
            logger.info("Unresolved path %s [%d-%d] in %s", name, node.start, node.end, node.sourceFile.name);
            return;
        }

        var typeFormat = format.formatType(typeInfo.type, nodeInfo);
        var resKind = typeFormat.kind || nodeInfo.kind;
        var defData = {
            Type: typeFormat.type,
            Keyword: resKind,
            Kind: nodeInfo.kind,
            Separator: resKind === "function" ? "" : " "
        };
        var def = {
            Path: scopePathForId,
            Name: name,
            Kind: nodeInfo.kind,
            File: node.sourceFile.name,
            DefStart: node.start,
            DefEnd: node.end,
            Data: defData
        };
        out.Defs.add(def);

        // Emit fake reference
        var ref = {
            DefPath: scopePathForId,
            Def: true,
            File: node.sourceFile.name,
            Start: node.start,
            End: node.end
        };
        out.Refs.add(ref);

        // Emit documentation
        if (documentation !== null && documentation.doc !== undefined) {
            var docData = {
                Path: scopePathForId,
                Format: "",
                Data: documentation.doc
            };
            out.Docs.add(docData);
        }
    } else {
        // emit reference
        var scopePathForDef = scope.mapLinesPathToScopePath(ternServer, {
            file: data.origin,
            start: data.start,
            end: data.end
        });
        if (!scopePathForDef) {
            if (data.url) {
                var urlStruct = url.parse(data.url);
                var envRef = {
                    DefPath: data.url,
                    DefUnitType: "URL",
                    DefRepo: urlStruct.protocol + (urlStruct.slashes ? "//" : "") + urlStruct.host,
                    Def: false,
                    File: node.sourceFile.name,
                    Start: node.start,
                    End: node.end
                };
                out.Refs.add(envRef);
                return;
            }

            undefinedIdents = undefinedIdents + 1;
            logger.info("Unresolved scope def path %s [%d-%d] in %s", name, node.start, node.end, node.sourceFile.name);
            return;
        }
        var ref = {
            DefPath: scopePathForDef,
            Def: false,
            File: node.sourceFile.name,
            Start: node.start,
            End: node.end
        };
        if (externalRepo != null) {
            ref.DefRepo = externalRepo.repo;
            ref.DefUnit = externalRepo.unit;
        }
        out.Refs.add(ref);
    }
}