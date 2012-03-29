/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 */

/* Test the Mako API endpoints */

var test = require('tap').test;
var http = require('http');
var util = require('util'),
    exec = require('child_process').exec;
var fs = require('fs');
var uuid = require('node-uuid');
var path = require('path');

var dir = '/var/tmp/test.mako.' + process.pid;
var file = path.join(dir, uuid.v4());

var options = {
	host: 'localhost',
	port: 4444,
	path: '/' + path.basename(file)
};

var assertFilesSame = function (first, second, t, callback) {
	exec('diff ' + first + ' ' + second,
	    function (err, stdout, stderr) {
		t.equal(err, null, first + ' and ' + second + ' are ' +
		    'not the same');
		callback(null);
	});
};

test('setup', function (t) {
	fs.mkdirSync(dir);

	exec('dd if=/dev/urandom of=' + file + ' count=80 bs=128k',
	    function (err, stdout, stderr) {
		if (err)
			throw (err);
		t.end();
	});
});

test('put an object', function (t) {
	options.method = 'PUT';

	var req = http.request(options, function (res) {
		console.log('STATUS: ' + res.statusCode);
		console.log('HEADERS: ' + JSON.stringify(res.headers));
		t.equal(res.statusCode, 204);
		t.end();
	});

	req.on('error', function (e) {
		console.log('problem with request: ' + e.message);
		t.end();
	});

	fs.readFile(file, function (err, contents) {
		req.write(contents);
		req.end();
	});
});

test('get an object', function (t) {
	options.method = 'GET';

	var req = http.request(options, function (res) {
		console.log('STATUS: ' + res.statusCode);
		console.log('HEADERS: ' + JSON.stringify(res.headers));

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

	req.on('error', function (e) {
		console.log('problem with request: ' + e.message);
		t.end();
	});
});

test('teardown', function (t) {
//	fs.unlink('./data/10m-file', function (err) {
		t.end();
//	});
});
