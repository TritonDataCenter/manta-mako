#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
#

set -o xtrace

SOURCE="${BASH_SOURCE[0]}"
if [[ -h $SOURCE ]]; then
    SOURCE="$(readlink "$SOURCE")"
fi
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"

MANTA_ROOT=/manta
MINNOW_PATH=/opt/smartdc/minnow
MINNOW_CFG=${MINNOW_PATH}/etc/config.json
NGINX_TEMP=${MANTA_ROOT}/nginx_temp
SVC_ROOT=/opt/smartdc/mako
ZONE_UUID=$(zonename)
ZONE_DATASET=zones/$ZONE_UUID/data

source ${DIR}/scripts/services.sh
source ${DIR}/scripts/util.sh

# No node in mako
export PATH=$MINNOW_PATH/build/node/bin:$MINNOW_PATH/node_modules/.bin:/opt/local/bin:/usr/sbin:/usr/bin:$PATH


function manta_update_compute_id {
    local SERVER_UUID TMP_FILE ZONE_UUID CURL_EXIT MANTA_COMPUTE_ID update

    SERVER_UUID=$(mdata-get sdc:server_uuid)
    [[ $? -eq 0 ]] || fatal "Unable to retrieve server_uuid"

    TMP_FILE=/var/tmp/manta_update_compute_id.$$
    ZONE_UUID=$(zonename)

    # See MANTA-1981... a loop here is a work around for an un-root-caused
    # failure case.
    CURL_EXIT=1
    for i in {1..60}; do
        curl -s ${SAPI_URL}/configs/$(zonename) 2>&1 > ${TMP_FILE}
        CURL_EXIT=$?
        if [[ $CURL_EXIT -eq 0 ]]; then
            break;
        fi
        echo "unable to fetch config from sapi, exit code $CURL_EXIT, sleeping"
        sleep 1;
    done
    [[ $CURL_EXIT -eq 0 ]] || fatal "unable to fetch config from sapi, exit code $CURL_EXIT"

    MANTA_COMPUTE_ID=$(json -f ${TMP_FILE} metadata.SERVER_COMPUTE_ID_MAPPING.${SERVER_UUID})
    [[ $? -eq 0 ]] || fatal "Unable to retrieve manta_compute_id"

    update=/opt/smartdc/config-agent/bin/mdata-update
    ${update} MANTA_COMPUTE_ID $MANTA_COMPUTE_ID
    [[ $? -eq 0 ]] || fatal "Unable to update manta_compute_id"

    rm ${TMP_FILE}
    [[ $? -eq 0 ]] || fatal "Unable to remove $TMP_FILE"
}


function manta_setup_minnow {
    local storage_moray_shard

    storage_moray_shard=$(json -f ${METADATA} STORAGE_MORAY_SHARD)
    [[ -n "$storage_moray_shard" ]] || \
        fatal "Unable to retrieve storage_moray_shard"

    manta_ensure_moray "$storage_moray_shard"

    svccfg import /opt/smartdc/minnow/smf/manifests/minnow.xml
    svcadm enable minnow

    manta_add_logadm_entry "minnow"
}


function manta_setup_nginx {
    echo "Updating ZFS configuration"

    mkdir -p $MANTA_ROOT

    local mountpoint=$(zfs get -H -o value mountpoint $ZONE_DATASET)
    if [[ ${mountpoint} != "/manta" ]]; then
        zfs set mountpoint=$MANTA_ROOT $ZONE_DATASET || \
            fatal "failed to set mountpoint"

        chmod 777 $MANTA_ROOT
        chown nobody:nobody $MANTA_ROOT
    fi

    zfs set compression=lz4 $ZONE_DATASET || \
       fatal "failed to enable compression"

    mkdir -p $NGINX_TEMP

    svccfg import /opt/smartdc/mako/smf/manifests/nginx.xml
    svcadm enable mako

    #
    # This logadm entry is added directly since the manta_add_logadm_entry
    # function handles only a single file.  The nginx service has two logs
    # (access and error log), and it should only be refreshed once while
    # rotating both logs.
    #
    # The post_command provided to logadm does several things:
    #
    #     (1) Sends SIGUSR1 to the nginx master process to tell it to drain
    #         current log entries and open fresh log files.
    #     (2) The rotated log files do not exactly match the format expected by
    #         the log uploader, so rename them to comply with tha uploader's
    #         expected format.
    #
    if [[ ! -f /var/log/mako-access.log ]]; then
        touch /var/log/mako-access.log
    fi
    if [[ ! -f /var/log/mako-error.log ]]; then
        touch /var/log/mako-error.log
    fi

    logadm -w mako_logs -C 48 -p 1h \
        -t '/var/log/manta/upload/$basename_$nodename_%FT%H:00:00.log' \
        -a 'pkill -USR1 -ox nginx; cd /var/log/manta/upload; for file in mako-error.log_* mako-access.log_*; do mv "$file" "${file/.log_/_}"; done' \
        '/var/log/mako-{access,error}.log'
}


function manta_setup_rebalancer_agent {
    svccfg import /opt/smartdc/rebalancer-agent/smf/manifests/rebalancer-agent.xml

    manta_add_logadm_entry "rebalancer-agent"
}


function manta_setup_crons {
    local crontab=/tmp/.manta_mako_cron
    crontab -l > $crontab
    [[ $? -eq 0 ]] || fatal "Unable to write to $crontab"

    #Before you change cron scheduling, please consult the Mola System "Crons"
    # Overview documentation (manta-mola.git/docs/system-crons)

    echo '15 12 * * * /opt/smartdc/mako/bin/mako_gc.sh >>/var/log/mako-gc.log 2>&1' >>$crontab
    echo '1 8 * * * /opt/smartdc/mako/bin/upload_mako_ls.sh >>/var/log/mako-ls-upload.log 2>&1' >>$crontab

    crontab $crontab
    [[ $? -eq 0 ]] || fatal "Unable import crons"

    manta_add_logadm_entry "mako-gc" "/var/log" "exact"
    manta_add_logadm_entry "mako-ls-upload" "/var/log" "exact"
}



# Mainline

echo "Running common pre-setup scripts"
manta_common_presetup

echo "Adding local manifest directories"
manta_add_manifest_dir "/opt/smartdc/mako"
manta_add_manifest_dir "/opt/smartdc/minnow"
manta_add_manifest_dir "/opt/smartdc/rebalancer-agent"

echo "Updating manta compute id"
manta_update_compute_id

echo "Running common setup scripts"
manta_common_setup "mako"

manta_ensure_zk

echo "Updating minnow"
manta_setup_minnow

echo "Updating nginx"
manta_setup_nginx

echo "Updating crons for garbage collection, etc."
manta_setup_crons

echo "Updating rebalancer"
manta_setup_rebalancer_agent

manta_common_setup_end

exit 0
