/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A simple PUT/GET/DELETE HTTP API for object storage.
 */

var assert = require('assert').ok,
    async = require('async'),
    fs = require('fs'),
    fsattr = require('fsattr'),
    Logger = require('bunyan'),
    path = require('path'),
    restify = require('restify');

var log = new Logger({ name: 'HTTPObjectStorageAPI' });

var server = restify.createServer({
    name: 'HTTPObjectStorageAPI'
});

var DATA_DIR = process.env.DATA_DIR || '/var/tmp/mako/';
fs.mkdir(DATA_DIR, function (err) {
	if (err && err.code !== 'EEXIST')
		throw (err);

	server.listen(80, function () {
    		log.info({url: server.url}, '%s listening', server.name);
	});
});

/*
 * Return a list of objects stored on this node.
 */
server.get('/', function (req, res, next) {
	log.debug('GET /');

	fs.readdir(DATA_DIR, function (err, files) {
		if (err)
			throw (err);

		var results = [];

		async.forEach(files, function (file, callback) {
			fs.stat(path.join(DATA_DIR, file),
			    function (suberr, stat) {
				if (suberr)
					return (callback(suberr));

				results.push({
				    id: file,
				    blksize: stat.blksize,
				    size: stat.size,
				    mtime: stat.mtime,
				    ctime: stat.ctime
				});

				return (callback(null));
			});
		}, function (suberr) {
			if (suberr) {
				log.error(suberr.message);
				res.send(503);
				return (next());
			}

			res.send(results);
			res.end();
			return (next());
		});
	});
});

/*
 * Return the number of objects stored on this node.
 */
server.head('/', function (req, res, next) {
	log.debug('HEAD /');

	fs.stat(DATA_DIR, function (err, stat) {
		if (err)
			throw (err);

		var count = stat.size - 2;
		res.header('X-Mako-Object-Count', count);
		res.send(204);
		res.end();
		return (next());
	});
});

server.get('/:id', function (req, res, next) {
	var id = req.params.id;
	log.debug('GET /' + id);

	var file = path.join(DATA_DIR, id);

	async.series([function (callback) {
		fs.stat(file, function (err, stat) {
			if (err && err.code === 'ENOENT') {
				log.warn('Object ' + id + 'not found: ' +
				    err.message);
				res.send(404);
				return (next());
			} else if (err) {
				log.error('fs.stat() error for ' + id + ': ' +
				     err.message);
				res.send(503);
				return (next());
			}
			return (callback(null, stat));
		});
	}, function (callback) {
		fs.open(file, 'r', function (err, fd) {
			if (err) {
				log.error('fs.open() error for ' + id + ': ' +
				     err.message);
				res.send(503);
				return (next());
			}

			return (callback(null, fd));
		});
	}], function (err, results) {
		assert(!err);
		assert(results.length === 2);
		var stat = results[0];
		var fd = results[1];

		res.writeHead(200, {
		    'Content-Length': stat.size,
		    'I-Am-A-Fake-Header': 'yesIam'
		});

		fs.close(fd);

		var rstream = fs.createReadStream(file);

		rstream.on('error', function (suberr) {
			if (suberr.code === 'ENOENT') {
				log.warn('Object ' + id + 'not found: ' +
				    suberr.message);

				res.send(404);
				return (next());
			}

			log.error('Error when creating read stream for ' + id +
			    ': ' + suberr.message);
			res.send(503);
			return (next());
		});

		rstream.pipe(res);

		rstream.on('end', function (suberr) {
			if (suberr)
				throw (suberr);
			res.end();
			return (next());
		});

		/* Don't actually use sendfile yet */
		var flag = true;
		if (flag)
			return;

		/*
		 * This is a bit of a hack: since fs.sendfile() doesn't use
		 * res.write() or a similar method, fs.sendfile() will start
		 * blasting data over the file descriptor as soon as it's
		 * called.  This may happen even before the headers are sent,
		 * since writeHead() caches the headers and sends them with the
		 * first body chunk.  This res._send() calls implicitly forces
		 * the headers to be sent.
		 */
		res._send('');

		fs.sendfile(req.socket._handle.fd, fd, 0, stat.size,
		    function (suberr, len) {
			if (suberr)
				throw (suberr);
			fs.close(fd);
			res.end();
			return (next());
		});
	});
});

server.put('/:id', function (req, res, next) {
	var id = req.params.id;
	log.debug('PUT /' + id);

	var file = path.join(DATA_DIR, id);
	var errno = -1;

	try {
		fs.statSync(file);
	} catch (err) {
		if (err && err.code === 'ENOENT') {
			errno = 2;
		} else if (err) {
			log.error('Error when deleting ' + id +
			    ': ' + err.message);
			res.send(503);
			return (next());
		}
	}

	if (errno === 2) {
		var wstream = fs.createWriteStream(file,
		    { flags: 'w' });
		req.pipe(wstream);

		req.on('end', function (suberr) {
			if (suberr)
				throw (suberr);

			/*
			 * XXX I'm not actually sure which properties I want to
			 * store as extended attributes, but this call at least
			 * shows the API is working as intended.
			 */
			fsattr.put(file, 'mako-props', {
			    'x-mako-remote-ip':  '1.2.3.4'
			}, function (err) {
				if (err) {
					log.warn('failed to write fsattrs' +
					    err.message);
				}
				res.send(201);
				return (next());
			});
		});

		req.on('error', function (suberr) {
			log.error('Error writing file: ' + suberr.message);
			res.send(503);
			return (next());
		});
	} else {
		/*
		 * If the fs.stat() call succeeds, then the object with this ID
		 * already exists and we shouldn't overwrite it.
		 */
		res.send(409);
		return (next());
	}

});

server.del('/:id', function (req, res, next) {
	var id = req.params.id;
	log.debug('DELETE /' + id);

	var file = path.join(DATA_DIR, id);

	fs.unlink(file, function (err) {
		if (err && err.code === 'ENOENT') {
			log.warn('Object ' + id + 'not found: ' +
			    err.message);
			res.send(404);
			return (next());
		} else if (err) {
			log.error('Error when deleting ' + id +
			    ': ' + err.message);
			res.send(503);
			return (next());
		}

		res.send(204);
		return (next());
	});
});
