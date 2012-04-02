/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var fs = require('fs');
var async = require('async');
var restify = require('restify');
var Logger = require('bunyan');
var path = require('path');

var log = new Logger({ name: 'HTTP Storage API' });

var server = restify.createServer({
    name: 'HTTPStorageAPI'
});

var DATA_DIR = process.env.DATA_DIR || '/var/tmp/mako/';
fs.mkdir(DATA_DIR, function (err) {
	if (err && err.code !== 'EEXIST')
		throw (err);

	server.listen(4444, function () {
    		log.info({url: server.url}, '%s listening', server.name);
	});
});

/*
 * Return a list of files managed on this storage node.
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

server.head('/', function (req, res, next) {
	log.debug('HEAD /');

	fs.stat(DATA_DIR, function (err, stat) {
		if (err)
			throw (err);

		/* XXX This is busted */
		res.write(stat.size - 2);
		res.end();
		return (next());
	});
});

server.get('/:id', function (req, res, next) {
	var id = req.params.id;
	log.debug('GET /' + id);

	var file = path.join(DATA_DIR, id);
	var rstream = fs.createReadStream(file);

	rstream.on('error', function (err) {
		if (err.code === 'ENOENT') {
			log.warn('Object ' + id + 'not found: ' +
			    err.message);

			res.send(404);
			return (next());
		}

		log.error('Error when creating read stream for ' + id +
		    ': ' + err.message);
		res.send(503);
		return (next());
	});

	rstream.pipe(res);

	rstream.on('end', function (err) {
		if (err)
			throw (err);
		res.end();
		return (next());
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
			res.send(204);
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
