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

function fatal {
    local LNOW=`date`
    echo "$LNOW: $(basename $0): fatal error: $*" >&2
    exit 1
}


function log {
    local LNOW=`date`
    echo "$LNOW: $(basename $0): info: $*" >&2
}


function sign() {
    NOW=$(date -u "+%a, %d %h %Y %H:%M:%S GMT")
    SIGNATURE=$(echo $NOW | tr -d '\n' | \
        openssl dgst -sha256 -sign $SSH_KEY | \
        openssl enc -e -a | tr -d '\n') \
        || fatal "unable to sign data"
}


function manta_get_no_fatal() {
    sign || fatal "unable to sign"
    curl -fsSk \
        -X GET \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 2>&1
}


function manta_get_to_file() {
    sign || fatal "unable to sign"
    curl -fsSk \
        -X GET \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 >$2 \
        || fatal "unable to get $1"
}


function manta_delete() {
    sign || fatal "unable to sign"
    curl -fsSk \
        -X DELETE \
        -H "Date: $NOW" \
        -H "Authorization: Signature $AUTHZ_HEADER $SIGNATURE" \
        -H "Connection: close" \
        $MANTA_URL/$MANTA_USER/stor$1 \
        || fatal "unable to delete $1"
}



## Main

: ${ZONENAME:?"Zonename must be set."}

log "starting gc"

FILE_COUNT=0
OBJECT_COUNT=0
MPATH=/manta_gc/mako/$ZONENAME
TMP_DIR=/tmp/mako_gc

GET_RES=`manta_get_no_fatal $MPATH`
if [[ $? -ne 0 ]]
then
    if [[ "$GET_RES" == *404* ]]
    then
        log "GC not ready yet: $MPATH $GET_RES"
        exit 0
    else
	fatal "$MPATH $GET_RES"
    fi
fi

mkdir -p $TMP_DIR

while read -r JSON
do
    if [[ "$JSON" == "" ]]
    then
        break
    fi

    FILE=$(echo $JSON | json -a name)
    MFILE=$MPATH/$FILE
    LFILE=$TMP_DIR/$FILE
    manta_get_to_file $MFILE $LFILE

    while read -r LINE
    do
	#Filter out any lines that aren't meant for this zone...
	if [[ ! $LINE =~ mako.*$ZONENAME ]]
	then
            continue
	fi
        #Fields 5 and 6 are the owner and object ids, respectively.
	OBJECT=`echo "$LINE" | cut -f 5,6 | tr '\t' '/' | xargs -i echo /manta/{}`
	if [[ -f $OBJECT ]]
	then
	    log "Removing $OBJECT. Line: {$LINE}"
	    rm $OBJECT
	    [[ $? -eq 0 ]] || fatal "Couldn't remove $OBJECT"
	    OBJECT_COUNT=$[OBJECT_COUNT + 1]
	else
	    log "$OBJECT doesn't exist, so not removing.  Line: {$LINE}."
	fi
    done < "$LFILE"

    rm $LFILE
    manta_delete $MFILE

    FILE_COUNT=$[FILE_COUNT + 1]

    log "success processing $MFILE."
done <<< "$GET_RES"

log "gc done, processed $FILE_COUNT files and $OBJECT_COUNT objects"
exit 0;
