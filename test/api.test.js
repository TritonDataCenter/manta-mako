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
		t.equal(err, null, first + ' and ' + second + ' are the same');
		return (callback(null));
	});
};

var createFile = function (name, size, callback) {
	var blocks = size / 131072;
	exec('dd if=/dev/urandom of=' + name + ' count=' + blocks + ' bs=128k',
	    function (err, stdout, stderr) {
		if (err)
			throw (err);
		return (callback(null));
	});
};

test('setup', function (t) {
	fs.mkdirSync(dir);
	createFile(file, 10 * 1024 * 1024, function () {
		t.end();
	});
});

test('put 10 MiB object', function (t) {
	options.method = 'PUT';

	var req = http.request(options, function (res) {
		console.log('STATUS: ' + res.statusCode);
		console.log('HEADERS: ' + JSON.stringify(res.headers));
		t.equal(res.statusCode, 204);
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

test('put existing object', function (t) {
	options.method = 'PUT';

	var req = http.request(options, function (res) {
		console.log('STATUS: ' + res.statusCode);
		console.log('HEADERS: ' + JSON.stringify(res.headers));
		t.equal(res.statusCode, 409);
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

test('delete 10 MiB object', function (t) {
	options.method = 'DELETE';

	var req = http.request(options, function (res) {
		console.log('STATUS: ' + res.statusCode);
		console.log('HEADERS: ' + JSON.stringify(res.headers));

		t.equal(res.statusCode, 204);

		options.method = 'GET';

		req = http.request(options, function (subres) {
			console.log('STATUS: ' + subres.statusCode);
			console.log('HEADERS: ' +
			    JSON.stringify(subres.headers));

			t.equal(subres.statusCode, 404);
			t.end();
		});
		req.end();
	});
	req.end();

	req.on('error', function (err) {
		console.log('problem with request: ' + err.message);
		t.ok(false, err.message);
		t.end();
	});
});

test('get nonexistent object', function (t) {
	options.method = 'GET';

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
});

test('teardown', function (t) {
	return (t.end());

	fs.readdir(dir, function (err, files) {
		if (err)
			throw (err);

		for (var ii = 0; ii < files.length; ii++)
			fs.unlinkSync(path.join(dir, files[ii]));
		fs.rmdirSync(dir);
		t.end();
	});
});
