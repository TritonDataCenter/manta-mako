#!/bin/bash

###############################################################################
# This cleans manta objects by first sucking down all files under:
#  /manta_gc/mako/$ZONENAME
# Which come in the following format:
#  mako + \t + serverUrl + \t + serverId + \t + zoneId + \t + ownerId +
#    \t + objectId
#
# Since manta objects are kept under /manta/ownerId/objectId, the ids are taken
# from the lines in the file and used to find and unlink the objects on the
# local filesystem.  When it is done it deletes the file in manta.
###############################################################################

export PATH=/opt/local/bin:$PATH



## Global vars

# Immutables

[ -z $SSH_KEY ] && SSH_KEY=/root/.ssh/id_rsa
[ -z $MANTA_KEY_ID ] && MANTA_KEY_ID=$(ssh-keygen -l -f $SSH_KEY.pub | awk '{print $2}')
[ -z $MANTA_URL ] && MANTA_URL=$(mdata-get manta_url)
[ -z $MANTA_USER ] && MANTA_USER=poseidon
[ -z $ZONENAME ] && ZONENAME=$(/usr/bin/zonename)

AUTHZ_HEADER="keyId=\"/$MANTA_USER/keys/$MANTA_KEY_ID\",algorithm=\"rsa-sha256\""
DIR_TYPE='application/json; type=directory'
LOG_TYPE='application/x-bzip2'

# Mutables

NOW=""
SIGNATURE=""



## Functions

function fail() {
    echo "$*" >&2
    exit 1
}


function sign() {
    NOW=$(date -u "+%a, %d %h %Y %H:%M:%S GMT")
    SIGNATURE=$(echo $NOW | tr -d '\n' | \
        openssl dgst -sha256 -sign $SSH_KEY | \
        openssl enc -e -a | tr -d '\n') \
        || fail "unable to sign data"
}


function manta_get() {
    sign || fail "unable to sign"
    curl -fsSk \
        -X GET \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 \
        || fail "unable to get $1"
}


function manta_delete() {
    return;
    sign || fail "unable to sign"
    curl -fsSk \
        -X DELETE \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 \
        || fail "unable to delete $1"
}



## Main

: ${ZONENAME:?"Zonename must be set."}

MPATH=/manta_gc/mako/$ZONENAME
for file in `manta_get $MPATH | json -a name`
do
    #Fields 5 and 6 are the owner and object ids, respectively.
    MFILE=$MPATH/$file
    (manta_get $MFILE | \
        grep "^mako.*$ZONENAME" | \
        cut -f 4,5 | tr '\t' '/' | xargs -i rm -f /manta/{} && \
        manta_delete $MFILE && \
        echo "SUCCESS processing $MFILE.") || \
	echo "ERROR processing $MFILE."
done
