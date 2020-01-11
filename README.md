<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2020 Joyent, Inc.
-->

# manta-mako

This repository is part of the Joyent Manta project.  For contribution
guidelines, issues, and general documentation, visit the main
[Manta](http://github.com/joyent/manta) project page.

Mako can refer to this repository or the zone in Manta that stores Manta
objects.  The zone that stores objects is also known as a "storage" zone.
[Nginx](http://nginx.org/) is the server that actually puts and gets the objects
to/from disk.

## Active Branches

There are currently two active branches of this repository, for the two
active major versions of Manta. See the [mantav2 overview
document](https://github.com/joyent/manta/blob/master/docs/mantav2.md) for
details on major Manta versions.

- [`master`](../../tree/master/) - For development of mantav2, the latest
  version of Manta. This is the version used by Triton.
- [`mantav1`](../../tree/mantav1/) - For development of mantav1, the long
  term support maintenance version of Manta.

## Repository

    bin/            Commands available in $PATH, including commands that work
                    in conjunction with Manta Garbage Collection
                    (manta-mola.git)
    boot/           Configuration scripts on zone setup.
    deps/           Git submodules and/or commited 3rd-party deps should go
                    here. See "node_modules/" for node.js deps.
    node_modules/   Node.js deps, either populated at build time or commited.
                    See Managing Dependencies.
    sapi_manifests/ SAPI manifests for zone configuration.
    smf/manifests   SMF manifests
    test/           Test suite (using node-tap)
    tools/          Miscellaneous dev/upgrade/deployment tools and data.
    Makefile
    package.json    npm module info (holds the project version)
    README.md

## Working with the nginx git submodule

mako uses [Joyent's fork of nginx](https://github.com/joyent/nginx)
which has been modified to support some additional features:

* Calculates the md5 checksum of the streamed body and reports it.
* Ensures that all renames are atomic in the filesystem (proper use of
  fsync(2)).

To understand how the nginx repository is managed and how we cut
releases for use in mako, please read the
[README](https://github.com/joyent/nginx).  When updating the nginx
submodule in mako, the first step is to identify the release tag that
you should use. Once that's been identified, you can update the
submodule using something like the following flow:

```
$ git clone git@github.com:joyent/manta-mako.git
$ cd mako/
$ git submodule init
$ git submodule update
$ cd deps/nginx/
$ git checkout <tag>
$ cd ../..
$ git add deps/nginx
$ git diff --cached #to check the submodule git SHA
```

Then you can commit, test, and push like any other change.

## Testing

To run the mako test suite, you need to be able to run nginx in your
zone. The following should be run as a root user (or by a user who can
use pfexec as the primary administrator):

1. `gmake release`
2. Manually edit `build/nginx/conf/nginx.conf` to clean up the sapi manifest
2. `mkdir /manta`
3. `chmod 770 /manta`
4. `chown nobody:staff /manta`
5. Manually start nginx, by running `build/nginx/sbin/nginx`
6. Run the test suite by running `gmake test`
7. When finished, kill the nginx processes with something like `pkill -9 nginx`
8. When finished, clean out any left over temporary data via `rm -rf /manta/*`

Note, that the tests default to looking for nginx on
`http://localhost:80/`. This can be overriden by setting the `MAKO_HOST`
and `MAKO_PORT` environment variables. For example if you set
`MAKO_PORT=8080` and `MAKO_HOST=1.2.3.4`, we would instead look for a
server at `http://1.2.3.4:8080/`.

## SAPI Tunables

    MAKO_WORKER_PROCESSES      Number of nginx worker processes

    MAKO_WORKER_CONNECTIONS    Maximum number of connections per nginx worker
                               process

    MAKO_PROCESS_MANIFEST      Boolean value which when set, enables the post
                               processing of a mako manifest to produce a
                               summary as well.  The summary provides
                               storage consumption details on a per-account
                               basis along with a global total.  Both the full
                               manifest and the summary are uploaded to
                               /poseidon/stor/mako and
                               /poseidon/stor/mako/summary respectively.
