/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/* Test the Mako API endpoints */

var test = require('tap').test;

var async = require('async');
var cp = require('child_process');
var fs = require('fs');
var http = require('http');
var path = require('path');
var uuid = require('node-uuid');

var TEST_DIR = '/var/tmp/test.mako.' + process.pid;
var filename = uuid.v4();
var file = path.join(TEST_DIR, filename);

var options = {
        host: 'localhost',
        port: 80,
        path: '/' + filename
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
        options.path = '/' + filename;

        var req = http.request(options, function (res) {
                console.log('STATUS: ' + res.statusCode);
                console.log('HEADERS: ' + JSON.stringify(res.headers));
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
        fs.mkdirSync(TEST_DIR);
        createFile(file, 10 * 1024 * 1024, function () {
                t.end();
        });
});

test('get nonexistent object', function (t) {
        getNonexistentObject(t);
});

test('put 10 MiB object', function (t) {
        options.method = 'PUT';
        options.path = '/' + filename;

        var req = http.request(options, function (res) {
                console.log('STATUS: ' + res.statusCode);
                console.log('HEADERS: ' + JSON.stringify(res.headers));
                t.equal(res.statusCode, 201);
                t.end();
        });

        req.on('error', function (err) {
                console.log('problem with request: ' + err.message);
                t.ok(false, err.message);
                t.end();
        });

        fs.readFile(file, function (err, contents) {
                req.write(contents);
                req.end();
        });
});

test('get 10 MiB object', function (t) {
        options.method = 'GET';
        options.path = '/' + filename;

        var req = http.request(options, function (res) {
                console.log('STATUS: ' + res.statusCode);
                console.log('HEADERS: ' + JSON.stringify(res.headers));

                t.equal(res.statusCode, 200);

                var wstream = fs.createWriteStream(file + '.new');
                res.pipe(wstream);

                res.on('end', function () {
                        assertFilesSame(file, file + '.new', t,
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
                files.push(uuid.v4());

        async.series([ function (callback) {
                async.forEach(files, function (f, subcb) {
                        createFile(path.join(TEST_DIR, f),
                            131072 * 10, function (suberr) {
                                return (subcb(suberr));
                        });
                }, function (suberr) {
                        if (suberr) {
                                t.ok(false, suberr.message);
                                t.end();
                                return (callback(suberr));
                        }
                        return (callback(null));
                });
        }, function (callback) {
                async.forEach(files, function (f, subcb) {
                        options.method = 'PUT';
                        options.path = '/' + f;

                        var req = http.request(options,
                            function (res) {
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
                }, function (suberr) {
                        return (callback(null));
                });
        }], function (suberr, results) {
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
