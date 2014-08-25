<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# Joyent Engineering Guide

Repository: <git@git.joyent.com:eng.git>
Browsing: <https://mo.joyent.com/eng>
Who: Trent Mick, Dave Pacheco
Docs: <https://mo.joyent.com/docs/eng>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/TOOLS>


# Overview

This repo serves two purposes: (1) It defines the guidelines and best
practices for Joyent engineering work (this is the primary goal), and (2) it
also provides boilerplate for an SDC project repo, giving you a starting
point for many of the suggestion practices defined in the guidelines. This is
especially true for node.js-based REST API projects.

Start with the guidelines: <https://head.no.de/docs/eng>


# Repository

    deps/           Git submodules and/or commited 3rd-party deps should go
                    here. See "node_modules/" for node.js deps.
    docs/           Project docs (restdown)
    lib/            Source files.
    node_modules/   Node.js deps, either populated at build time or commited.
                    See Managing Dependencies.
    pkg/            Package lifecycle scripts
    smf/manifests   SMF manifests
    smf/methods     SMF method scripts
    test/           Test suite (using node-tap)
    tools/          Miscellaneous dev/upgrade/deployment tools and data.
    Makefile
    package.json    npm module info (holds the project version)
    README.md


# Development

To run the boilerplate API server:

    git clone git@git.joyent.com:eng.git
    cd eng
    git submodule update --init
    make all
    node server.js

To update the guidelines, edit "docs/index.restdown" and run `make docs`
to update "docs/index.html".

Before commiting/pushing run `make prepush` and, if possible, get a code
review.



# Testing

    make test

If you project has setup steps necessary for testing, then describe those
here.


# Starting a Repo Based on eng.git

Create a new repo called "some-cool-fish" in your "~/work" dir based on "eng.git":

    .../eng/tools/mkrepo $HOME/work/some-cool-fish


# Working with the nginx git submodule

To update nginx, first checkout out and make changes to the mako branch of the
github Joyent nginx fork located at https://github.com/joyent/nginx/tree/mako

Once your changes have been committed to that repo, grab the git SHA for your
changes and:

    $ git clone git@git.joyent.com:mako.git
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
