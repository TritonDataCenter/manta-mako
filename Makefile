#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
#

#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#

#
# Tools
#
NGXSYMCHECK	= tools/ngx_symcheck

#
# Files
#
DOC_FILES	=
BASH_FILES	= bin/manta-mako-adm $(NGXSYMCHECK)
SMF_MANIFESTS	= smf/manifests/nginx.xml
ESLINT_FILES := $(shell find bin lib test -name '*.js')

#
# Variables
#

# TODO: Use this to download or verify install of expected rust version
# NOTE: copied from what manta-buckets-mdapi uses
RUST_PREBUILT_VERSION = 1.40.0

NAME			= mako
NODE_PREBUILT_VERSION	= v8.17.0
NODE_PREBUILT_TAG	= zone64
# minimal-64 19.4.0
NODE_PREBUILT_IMAGE	= 5417ab20-3156-11ea-8b19-2b66f5e7a439

#
# Stuff used for buildimage
#
# triton-origin-x86_64-19.4.0
BASE_IMAGE_UUID		= 59ba2e5e-976f-4e09-8aac-a4a7ef0395f5
BUILDIMAGE_NAME		= mantav2-storage
BUILDIMAGE_DESC		= Manta Storage
BUILDIMAGE_PKGSRC	= pcre-8.43 findutils-4.6.0nb2 gawk-5.0.1
AGENTS = amon config minnow registrar rebalancer

ENGBLD_USE_BUILDIMAGE	= true
ENGBLD_REQUIRE :=	$(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)
include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
include ./deps/eng/tools/mk/Makefile.agent_prebuilt.defs
include ./deps/eng/tools/mk/Makefile.node_modules.defs
include ./deps/eng/tools/mk/Makefile.smf.defs
include ./tools/mk/Makefile.nginx.defs

ifneq ($(shell uname -s),SunOS)
       NPM=npm
       NODE=node
       NPM_EXEC=$(shell which npm)
       NODE_EXEC=$(shell which node)
endif

#
# MG Variables
#
ROOT            := $(shell pwd)
RELEASE_TARBALL := $(NAME)-pkg-$(STAMP).tar.gz
RELSTAGEDIR		:= /tmp/$(NAME)-$(STAMP)

#
# v8plus uses the CTF tools as part of its build, but they can safely be
# overridden here so that this works in dev zones without them.
# See marlin.git Makefile.
#
NPM_ENV          = NODE_ENV=production MAKE_OVERRIDES="CTFCONVERT=/bin/true CTFMERGE=/bin/true"

#
# Repo-specific targets
#
.PHONY: all
all: $(NODE_EXEC) $(NGINX_EXEC) $(REPO_DEPS) scripts build-rollup
	$(NPM) install --production

CLEAN_FILES += ./node_modules/ build

check:: $(NODE_EXEC)

# Just lint check (no style)
.PHONY: lint
lint: | $(ESLINT)
	$(ESLINT) --rule 'prettier/prettier: off' $(ESLINT_FILES)

.PHONY: fmt
fmt: | $(ESLINT)
	$(ESLINT) --fix $(ESLINT_FILES)

check-bash: $(NODE_EXEC)

.PHONY: test
test:
	@echo "To run tests, run:"
	@echo ""
	@echo "    ./test/runtests"
	@echo ""
	@echo "from the /opt/smartdc/mako directory on a storage instance."

.PHONY: scripts
scripts: deps/manta-scripts/.git
	mkdir -p $(BUILD)/scripts
	cp deps/manta-scripts/*.sh $(BUILD)/scripts

.PHONY: check-nginx
check-nginx: $(NGINX_EXEC)
	$(NGXSYMCHECK) $(NGINX_EXEC)
prepush: check-nginx

.PHONY: release
release: all deps docs $(SMF_MANIFESTS) check-nginx
	@echo "Building $(RELEASE_TARBALL)"
	@$(ROOT)/build/node/bin/node ./node_modules/.bin/kthxbai
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/mako
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	cp -r $(ROOT)/bin \
	    $(ROOT)/boot \
	    $(ROOT)/build/nginx \
	    $(ROOT)/lib \
	    $(ROOT)/node_modules \
	    $(ROOT)/sapi_manifests \
	    $(ROOT)/smf \
	    $(ROOT)/test \
	    $(RELSTAGEDIR)/root/opt/smartdc/mako/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/mako/build
	cp -r $(ROOT)/build/scripts $(RELSTAGEDIR)/root/opt/smartdc/mako/build/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/mako/build/node/bin \
		$(RELSTAGEDIR)/root/opt/smartdc/mako/build/node/lib
	cp -r $(ROOT)/build/node/lib/dtrace $(RELSTAGEDIR)/root/opt/smartdc/mako/build/node/lib/
	cp $(ROOT)/build/node/bin/node $(RELSTAGEDIR)/root/opt/smartdc/mako/build/node/bin/
	chmod 755 $(RELSTAGEDIR)/root/opt/smartdc/mako/build/node/bin/node
	cp $(ROOT)/mako_rollup/target/release/mako_rollup \
	    $(RELSTAGEDIR)/root/opt/smartdc/mako/bin/mako_rollup
	chmod 755 $(RELSTAGEDIR)/root/opt/smartdc/mako/bin/mako_rollup
	cp -r $(ROOT)/build/scripts $(RELSTAGEDIR)/root/opt/smartdc/mako/boot
	ln -s /opt/smartdc/mako/boot/setup.sh \
	    $(RELSTAGEDIR)/root/opt/smartdc/boot/setup.sh
	chmod 755 $(RELSTAGEDIR)/root/opt/smartdc/mako/boot/setup.sh
	rm $(RELSTAGEDIR)/root/opt/smartdc/mako/nginx/conf/*.default
	(cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

.PHONY: build-rollup
build-rollup:
	(cd mako_rollup && $(CARGO) build --release)
	find mako_rollup -ls

.PHONY: publish
publish: release
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(ROOT)/$(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)

include ./deps/eng/tools/mk/Makefile.deps
include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
include ./deps/eng/tools/mk/Makefile.agent_prebuilt.targ
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.nginx.targ
include ./deps/eng/tools/mk/Makefile.targ
