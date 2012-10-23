#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
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
TAP		:= ./node_modules/.bin/tap

#
# Files
#
DOC_FILES	 = index.restdown

include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.nginx.defs

ROOT            := $(shell pwd)
RELEASE_TARBALL := mako-pkg-$(STAMP).tar.bz2
TMPDIR          := /tmp/$(STAMP)

#
# Repo-specific targets
#
.PHONY: all
all: $(NGINX_EXEC)

$(TAP): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(TAP) ./node_modules/tap

.PHONY: test
test: $(TAP)
	TAP=1 $(TAP) test/*.test.js

.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(TMPDIR)/root/opt/smartdc/mako
	@mkdir -p $(TMPDIR)/site
	@touch $(TMPDIR)/site/.do-not-delete-me
	cp -r $(ROOT)/bin \
	    $(ROOT)/build/nginx \
	    $(ROOT)/smf \
	    $(TMPDIR)/root/opt/smartdc/mako/
	rm $(TMPDIR)/root/opt/smartdc/mako/nginx/conf/*.default
	(cd $(TMPDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(TMPDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/mako
	cp $(ROOT)/$(RELEASE_TARBALL) $(BITS_DIR)/mako/$(RELEASE_TARBALL)

include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.nginx.targ
include ./tools/mk/Makefile.targ
