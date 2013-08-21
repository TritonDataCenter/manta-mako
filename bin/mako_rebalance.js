#!/usr/bin/env node
// -*- mode: js -*-
// Copyright 2012 Joyent, Inc.  All rights reserved.

var assert = require('assert-plus');
var bunyan = require('bunyan');
var carrier = require('carrier');
var crypto = require('crypto');
var exec = require('child_process').exec;
var fs = require('fs');
var getopt = require('posix-getopt');
var http = require('http');
var manta = require('manta');
var moray = require('moray');
var path = require('path');
var vasync = require('vasync');



///--- Globals

var LOG = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'info'),
        name: 'moray_gc',
        stream: process.stdout
});
var REBALANCE_CONFIG = (process.env.REBALANCE_CONFIG ||
                        process.argv[2] ||
                        '/opt/smartdc/mako/etc/mako_rebalancer_config.json');
var MANTA = 'manta';
var MANTA_CLIENT = manta.createClientFromFileSync(REBALANCE_CONFIG, LOG);
var MANTA_USER = MANTA_CLIENT.user;
var REBALANCE_PATH_PREFIX = '/' + MANTA_USER + '/stor/manta_rebalance/do';
var OK_ERROR = new Error('Not really an error');
OK_ERROR.ok = true;
var LOCAL_TMP_DIR = '/manta/rebalance_tmp';


///--- Pipeline

function readConfig(_, cb) {
        fs.readFile(REBALANCE_CONFIG, function (err, contents) {
                if (err) {
                        cb(err);
                        return;
                }
                try {
                        var cfg = JSON.parse(contents);
                } catch (e) {
                        cb(e, 'error parsing config');
                        return;
                }

                LOG.info(cfg, 'config');

                assert.object(cfg, 'cfg');
                assert.string(cfg.manta_storage_id, 'cfg.manta_storage_id');
                assert.object(cfg.moray, 'cfg.moray');
                assert.string(cfg.moray.host, 'cfg.moray.host');
                assert.number(cfg.moray.port, 'cfg.moray.port');
                assert.number(cfg.moray.connectTimeout,
                              'cfg.moray.connectTimeout');
                _.cfg = cfg;
                cb();
        });
}


function checkForMantaObjects(_, cb) {
        _.rebalacePath = REBALANCE_PATH_PREFIX + '/' + _.cfg.manta_storage_id;
        MANTA_CLIENT.ls(_.rebalacePath, {}, function (err, res) {
                if (err) {
                        cb(err);
                        return;
                }

                var objs = [];

                res.on('object', function (o) {
                        objs.push(o);
                });

                res.once('error', function (err2) {
                        cb(err2);
                });

                res.once('end', function () {
                        if (objs.length < 1) {
                                LOG.info('No objects in directory, returning');
                                cb(OK_ERROR);
                                return;
                        }

                        LOG.info({
                                objects: objs,
                                path: _.rebalacePath
                        }, 'found objects');

                        _.rebalaceObjects = objs;
                        cb();
                });

        });
}


function initMorayClient(_, cb) {
        var cfg = {
                log: LOG,
                connectTimeout: _.cfg.moray.connectTimeout,
                host: _.cfg.moray.host,
                port: _.cfg.moray.port
        };

        var client = moray.createClient(cfg);
        client.on('connect', function () {
                _.morayClient = client;
                cb();
        });
}


function closeMorayClient(_, cb) {
        _.morayClient.close();
        cb();
}


function findLocalPermissions(_, cb) {
        //Need to get the user/group/mode for a directory under /manta
        // and a file under one of those.

        var uuidRegex = /\w{8}\-\w{4}\-\w{4}\-\w{4}\-\w{12}/;
        var dirs = fs.readdirSync('/manta');
        var dir = null;
        for (var i = 0; i < dirs.length; ++i) {
                if (uuidRegex.test(dirs[i])) {
                        dir = dirs[i];
                        break;
                }
        }
        var dirName = '/manta/' + dir;
        var files = fs.readdirSync(dirName);
        var file = null;
        for (i = 0; i < files.length; ++i) {
                if (uuidRegex.test(files[i])) {
                        file = files[i];
                        break;
                }
        }
        var fileName = dirName + '/' + file;

        var dirStat = fs.statSync(dirName);
        var fileStat = fs.statSync(fileName);
        LOG.info({
                dirName: dirName,
                dirStat: dirStat,
                fileName: fileName,
                fileStat: fileStat
        }, 'taking stat information from these');
        _.dirStat = dirStat;
        _.fileStat = fileStat;

        fs.mkdir(LOCAL_TMP_DIR, function (err) {
                if (err && err.code !== 'EEXIST') {
                        cb(err);
                }
                cb();
        });
}


function rebalanceMantaObjects(_, cb) {
        var i = 0;
        function rebalanceNext() {
                var mantaObject = _.rebalaceObjects[i];
                if (!mantaObject) {
                        cb();
                        return;
                }

                rebalanceMantaObject(_, mantaObject, function (err) {
                        if (err) {
                                LOG.error({
                                        err: err,
                                        mantaObject: mantaObject
                                }, 'error while processing manta object');
                                cb(err);
                                return;
                        }

                        var mop = _.rebalacePath + '/' + mantaObject.name;
                        MANTA_CLIENT.unlink(mop, {}, function (err2) {
                                if (err2) {
                                        cb(err2);
                                        return;
                                }
                                LOG.info({ obj: mantaObject },
                                         'Done with mantaObject');

                                ++i;
                                rebalanceNext();
                        });
                });
        }
        rebalanceNext();
}


function rebalanceMantaObject(_, mantaObject, cb) {
        LOG.info({
                mantaObject: mantaObject
        }, 'rebalancing mantaObject');

        var toProcess = 0;
        var processed = 0;
        var endCalled = false;
        var queue = vasync.queue(function (obj, subcb) {
                rebalance(_, obj, function (err) {
                        if (err && !err.ok) {
                                LOG.error({
                                        err: err,
                                        object: obj
                                }, 'error with object');
                        }
                        ++processed;
                        //Don't pass along the error, just keep going...
                        //TODO: Is ^^ the right call?
                        subcb();
                });
        }, 1); //Serialize, please.

        function tryEnd(err) {
                if (queue.npending === 0 && toProcess === processed &&
                    endCalled) {
                        cb();
                }
        }

        var mantaObjectPath = _.rebalacePath + '/' + mantaObject.name;
        MANTA_CLIENT.get(mantaObjectPath, {}, function (err, stream) {
                if (err) {
                        cb(err);
                        return;
                }

                var c = carrier.carry(stream);

                c.on('line', function (line) {
                        if (line === '') {
                                return;
                        }

                        try {
                                var dets = JSON.parse(line);
                        } catch (e) {
                                LOG.error({
                                        line: line,
                                        err: e
                                }, 'not parseable JSON');
                                return;
                        }

                        ++toProcess;
                        queue.push(dets, tryEnd);
                });

                c.on('error', function (err2) {
                        LOG.error(err2, 'during carrier');
                });

                c.on('end', function () {
                        LOG.info({
                                mantaObjectPath: mantaObjectPath
                        }, 'Done reading manta object');
                        endCalled = true;
                        tryEnd();
                });

                stream.resume();
        });
}


function rebalance(_, object, cb) {
        LOG.info({
                object: object
        }, 'starting pipeline for object');

        vasync.pipeline({
                funcs: [
                        setupPaths,
                        pullMorayObject,
                        pullObject,
                        updateMorayObject,
                        tombstoneOldObject
                ],
                arg: {
                        object: object,
                        pc: _
                }
        }, function (err) {
                cb(err);
        });
}


function setupPaths(_, cb) {
        var o = _.object;
        var today = (new Date()).toISOString().substring(0, 10);
        _.localDirectory = '/manta/' + o.owner;
        _.localFilename = _.localDirectory + '/' + o.objectId;
        _.remotePath = '/' + o.owner + '/' + o.objectId;
        _.remoteHost = o.oldShark.manta_storage_id;
        _.remoteLocation = 'http://' + _.remoteHost + _.remotePath;
        _.remoteTomb = '/tombstone/' + today + '/' + o.objectId;
        cb();
}


function pullMorayObject(_, cb) {
        var key = _.object.key;
        _.pc.morayClient.getObject(MANTA, key, {}, function (err, obj) {
                if (err && err.name === 'ObjectNotFoundError') {
                        LOG.info({
                                key: key
                        }, 'ObjectNotFoundError for key, ignoring');
                        cb(OK_ERROR);
                        return;
                }
                if (err) {
                        cb(err);
                        return;
                }

                //If the etag is off, just ignore.  We don't want to
                // accidentally overwrite data...

                //TODO: Checking this here risks creating cruft on the remote
                // node of the MOVE fails.
                if (obj._etag !== _.object.morayEtag) {
                        LOG.info({
                                key: key,
                                objEtag: obj._etag,
                                morayObjEtag: _.object.morayEtag
                        }, 'Moray etag mismatch.  Ignoring object.');
                        cb(OK_ERROR);
                        return;
                }

                _.morayObject = obj;
                LOG.info({
                        key: key
                }, 'got moray object for key');
                cb();
        });
}


function pullObject(_, cb) {
        fs.stat(_.localFilename, function (err, stat) {
                if (err && err.code !== 'ENOENT') {
                        cb(err);
                        return;
                }

                //Already exists!
                if (!err && stat) {
                        cb();
                        return;
                }

                //Ok, must create
                createLocalDirectory(_, function (err2) {
                        if (err2) {
                                cb(err2);
                                return;
                        }

                        var fo = { mode: _.pc.fileStat.mode };
                        var tmpFileName = LOCAL_TMP_DIR + '/' +
                                _.object.objectId;
                        var fstream = fs.createWriteStream(tmpFileName, fo);
                        var hash = crypto.createHash('md5');

                        var error = null;
                        function afterEnd() {
                                if (error) {
                                        cb(error);
                                        return;
                                }

                                var calMd5 = hash.digest('base64');
                                if (calMd5 !== _.object.md5) {
                                        error = new Error();
                                        error.code = 'Md5Mismatch';
                                        error.message = 'Calculated md5: ' +
                                                calMd5 + ' didn\'t match ' +
                                                _.object.md5;
                                        cb(error);
                                        return;
                                }

                                fs.chownSync(tmpFileName,
                                             _.pc.fileStat.uid,
                                             _.pc.fileStat.gid);
                                fs.renameSync(tmpFileName, _.localFilename);

                                cb();
                        }

                        LOG.info({
                                remoteLocation: _.remoteLocation,
                                localFile: _.localFilename,
                                tmpFileName: tmpFileName
                        }, 'getting');
                        http.get(_.remoteLocation, function (res) {
                                res.once('error', function (err3) {
                                        res.removeAllListeners();
                                        fstream.end();
                                        error = err3;
                                        return;
                                });

                                res.once('end', function () {
                                        fstream.end('', null, afterEnd);
                                });

                                res.pipe(fstream);
                                res.on('data', function (d) {
                                        hash.update(d);
                                });
                        });
                });
        });
}


function createLocalDirectory(_, cb) {
        var dir = _.localDirectory;
        if (!_.pc.knownDirs) {
                _.pc.knownDirs = {};
        }
        //Check in the cache first...
        if (_.pc.knownDirs[dir]) {
                cb();
                return;
        }
        LOG.info({
                directory: dir
        }, 'creating directory');
        fs.stat(dir, function (err, stat) {
                if (err && err.code !== 'ENOENT') {
                        cb(err);
                        return;
                } else if (err && err.code === 'ENOENT') {
                        fs.mkdirSync(dir, _.pc.dirStat.mode);
                        fs.chownSync(dir, _.pc.dirStat.uid, _.pc.dirStat.gid);
                }
                _.pc.knownDirs[dir] = true;
                cb();
        });
}


function updateMorayObject(_, cb) {
        var oldShark = _.object.oldShark;
        var newShark = _.object.newShark;

        var b = MANTA;
        var k = _.morayObject.key;
        var v = _.morayObject.value;
        var etag = _.morayObject._etag;
        var op = { etag: etag };

        for (var i = 0; i < v.sharks.length; ++i) {
                var s = v.sharks[i];
                if (s.manta_storage_id === oldShark.manta_storage_id &&
                    s.datacenter === oldShark.datacenter) {
                        v.sharks[i] = newShark;
                }
        }

        LOG.info({
                key: k,
                sharks: v.sharks
        }, 'updating moray object');

        //TODO: Will the etag mismatch also catch deleted objects?  How can
        // we detect that and get rid of the object (since it would be cruft
        // at that point?)
        _.pc.morayClient.putObject(b, k, v, op, function (e) {
                var ece = 'EtagConflictError';
                if (e && e.name !== ece) {
                        cb(e);
                        return;
                }
                if (e && e.name === ece) {
                        LOG.info({
                                key: k
                        }, 'Etag conflict');
                }
                cb();
        });
}


function tombstoneOldObject(_, cb) {
        var opts = {
                'method': 'MOVE',
                'hostname': _.remoteHost,
                'path': _.remotePath,
                'headers': {
                        'Destination': _.remoteTomb
                }
        };

        LOG.info({
                opts: opts,
                key: _.object.key
        }, 'moving remote object');

        var req = http.request(opts, function (res) {
                if (res.statusCode !== 204 &&
                    res.statusCode !== 404) {
                        LOG.error({
                                res: res,
                                opts: opts
                        }, 'unexpected response while moving object');
                }

                res.on('end', function () {
                        cb();
                });
        });

        req.on('error', function (err) {
                cb(err);
                return;
        });

        req.end();
}


///--- Main

vasync.pipeline({
        funcs: [
                readConfig,
                checkForMantaObjects,
                initMorayClient,
                findLocalPermissions,
                rebalanceMantaObjects,
                closeMorayClient
        ],
        arg: {}
}, function (err) {
        if (err && !err.ok) {
                LOG.fatal(err);
                process.exit(1);
        }
        MANTA_CLIENT.close();
        LOG.debug('Done.');
});
