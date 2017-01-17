<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2017 Joyent, Inc.
-->

# manta-mako

This repository is part of the Joyent Manta project.  For contribution
guidelines, issues, and general documentation, visit the main
[Manta](http://github.com/joyent/manta) project page.

Mako can refer to this repository or the zone in Manta that stores Manta
objects.  The zone that stores objects is also known as a "storage" zone.
[Nginx](http://nginx.org/) is the server that actually puts and gets the objects
to/from disk.

# Repository

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

# Working with the nginx git submodule

To update nginx, first checkout out and make changes to the mako branch of the
github Joyent nginx fork located at https://github.com/joyent/nginx/tree/mako

Once your changes have been committed to that repo, grab the git SHA for your
changes and:

    $ git clone git@github.com:joyent/manta-mako.git
    $ cd mako/
    $ git submodule init
    $ git submodule update
    $ cd deps/nginx/
    $ git checkout -b mako
    $ git checkout [Latest joyent/nginx#mako git SHA]
    $ cd ../..
    $ git add deps/nginx
    $ git diff --cached #to check the submodule git SHA

Then you can commit and push like any other change.

## Testing

To run the mako test suite, you need to be able to run nginx in your
zone. The following should be run as a root user (or by a user who can
use pfexec as the primary administrator):

1. `gmake release`
2. Manually edit `build/nginx/conf/nginx.conf` to clean up the sapi manifest
2. `mkdir /manta`
3. `chmod 770 /manta`
4. `chown nobody:staff /manta`
5. Manually start nginx, by running `build/nginx/objs/nginx`
6. Run the test suite by running `gmake test`
7. When finished, kill the nginx processes with something like `pkill -9 nginx`
7. When finished, clean out any left over temporary data via `rm -rf /manta/*`
