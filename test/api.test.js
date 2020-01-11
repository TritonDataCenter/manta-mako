/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/* Test the Mako API endpoints */

var cp = require('child_process');
var fmt = require('util').format;
var fs = require('fs');
var http = require('http');
var path = require('path');

var uuid = require('uuid/v4');
var vasync = require('vasync');

var test = require('@smaller/tap').test;

var TEST_DIR = '/var/tmp/test.mako.' + process.pid;
var FILENAME = uuid();
var FILE = path.join(TEST_DIR, FILENAME);

var options = {
        host: 'localhost',
        port: 80,
        path: '/' + FILENAME
};

var assertFilesSame = function (first, second, t, callback) {
        cp.exec('diff ' + first + ' ' + second,
            function (err, stdout, stderr) {
                t.equal(err, null, first + ' and ' + second + ' are the same');
                return (callback(null));
        });
};

var createFile = function (name, size, callback) {
        var blocks = size / 131072;
        cp.exec('dd if=/dev/urandom of=' + name + ' count=' +
            blocks + ' bs=128k', function (err, stdout, stderr) {
                if (err)
                        throw (err);
                return (callback(null));
        });
};

var getNonexistentObject = function (t) {
        options.method = 'GET';
        options.path = '/' + FILENAME;

        var req = http.request(options, function (res) {
                console.log('STATUS: ' + res.statusCode);
                console.log('HEADERS: ' + JSON.stringify(res.headers));
                res.resume();
                t.equal(res.statusCode, 404);
                t.end();
        });
        req.end();

        req.on('error', function (err) {
                console.log('problem with request: ' + err.message);
                t.ok(false, err.message);
                t.end();
        });
};

test('setup', function (t) {
        var port;
        if (process.env['MAKO_HOST']) {
                options.host = process.env['MAKO_HOST'];
        }

        if (process.env['MAKO_PORT']) {
                port = parseInt(process.env['MAKO_PORT'], 10);
                if (isNaN(port)) {
                        process.stderr.write(fmt('failed to parse port: ' +
                            '%d: using default: %d\n', process.env['MAKO_PORT'],
                            options.port));
                } else {
                        options.port = port;
                }
        }


        fs.mkdirSync(TEST_DIR);
        createFile(FILE, 10 * 1024 * 1024, function () {
                t.end();
        });
});

test('get nonexistent object', function (t) {
        getNonexistentObject(t);
});

test('put 10 MiB object', function (t) {
        options.method = 'PUT';
        options.path = '/' + FILENAME;

        var req = http.request(options, function (res) {
                console.log('STATUS: ' + res.statusCode);
                console.log('HEADERS: ' + JSON.stringify(res.headers));
                res.resume();
                t.equal(res.statusCode, 201);
                t.end();
        });

        req.on('error', function (err) {
                console.log('problem with request: ' + err.message);
                t.ok(false, err.message);
                t.end();
        });

        fs.readFile(FILE, function (err, contents) {
                req.write(contents);
                req.end();
        });
});

test('get 10 MiB object', function (t) {
        options.method = 'GET';
        options.path = '/' + FILENAME;

        var req = http.request(options, function (res) {
                console.log('STATUS: ' + res.statusCode);
                console.log('HEADERS: ' + JSON.stringify(res.headers));

                t.equal(res.statusCode, 200);

                var wstream = fs.createWriteStream(FILE + '.new');
                res.pipe(wstream);

                res.on('end', function () {
                        assertFilesSame(FILE, FILE + '.new', t,
                            function () {
                                t.end();
                        });
                });
        });
        req.end();

        req.on('error', function (err) {
                console.log('problem with request: ' + err.message);
                t.ok(false, err.message);
                t.end();
        });
});

test('100s of small files', function (t) {
        var files = [];
        for (var ii = 0; ii < 200; ii++)
                files.push(uuid());

        vasync.pipeline({funcs: [ function (_, callback) {
                vasync.forEach({inputs: files, func: function (f, subcb) {
                        createFile(path.join(TEST_DIR, f),
                            131072 * 10, function (suberr) {
                                return (subcb(suberr));
                        });
                }}, function (suberr) {
                        if (suberr) {
                                t.ok(false, suberr.message);
                                t.end();
                                return (callback(suberr));
                        }
                        return (callback(null));
                });
        }, function (_, callback) {
                vasync.forEach({inputs: files, func: function (f, subcb) {
                        options.method = 'PUT';
                        options.path = '/' + f;

                        var req = http.request(options,
                            function (res) {
                                res.resume();
                                t.equal(res.statusCode, 201);
                                return (subcb(null));
                        });

                        req.on('error', function (suberr) {
                                console.log('problem with request: ' +
                                    suberr.message);
                                t.ok(false, suberr.message);
                                t.end();
                        });

                        fs.readFile(path.join(TEST_DIR, f),
                            function (suberr, contents) {
                                req.write(contents);
                                req.end();
                        });
                }}, function (suberr) {
                        return (callback(null));
                });
        }]}, function (suberr, results) {
                t.end();
        });
});

test('teardown', function (t) {
        fs.readdir(TEST_DIR, function (err, files) {
                if (err)
                        throw (err);

                for (var ii = 0; ii < files.length; ii++)
                        fs.unlinkSync(path.join(TEST_DIR, files[ii]));
                fs.rmdirSync(TEST_DIR);
                t.end();
        });
});
