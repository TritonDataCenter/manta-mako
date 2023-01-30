/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 * Copyright 2023 MNX Cloud, Inc.
 */
use std::collections::HashMap;
use std::path::Component;
use std::time::{Instant, SystemTime};
use walkdir::WalkDir;

struct Account {
    bytes: u64,
    objects: u64,
}

fn main() {
    let start = Instant::now();
    let mut accounts: HashMap<String, Account> = HashMap::new();

    // Traverse the manta directory to build up our HashMap of object and byte counts
    for entry in WalkDir::new("/manta") {
        let entry = entry.unwrap();
        let metadata = entry.path().metadata().expect("metadata call failed");

        // We only care about files, so we intentionally do nothing with directories
        if metadata.file_type().is_file() {
            let mut components = entry.path().components();

            // Ensure we got `/` (absolute path) and then `manta`
            assert_eq!(components.next(), Some(Component::RootDir));
            assert_eq!(components.next().unwrap().as_os_str(), "manta");

            let component = components.next().unwrap();

            let account_uuid = if component.as_os_str() == "v2" {
                // If the path starts with /manta/v2, the next component is the owner_uuid
                components.next().unwrap().as_os_str().to_str().unwrap()
            } else {
                // If the path starts with /manta/ but then has a uuid instead
                // of `v2`, that uuid is the creator uuid and this is a
                // mantav1 or mantav2 dir-style path.
                component.as_os_str().to_str().unwrap()
            };

            match accounts.get_mut(account_uuid) {
                Some(account) => {
                    let updated_bytes: u64 = account.bytes + metadata.len();
                    let updated_objects: u64 = account.objects + 1;
                    accounts.insert(
                        account_uuid.to_string(),
                        Account {
                            bytes: updated_bytes,
                            objects: updated_objects,
                        },
                    );
                }
                None => {
                    let first_bytes: u64 = metadata.len();
                    accounts.insert(
                        account_uuid.to_string(),
                        Account {
                            bytes: first_bytes,
                            objects: 1,
                        },
                    );
                }
            }
        }
    }

    println!(
        "# HELP used_bytes The current number of bytes used on a mako\n# TYPE used_bytes gauge"
    );

    for (k, v) in accounts.iter() {
        println!("used_bytes{{account=\"{}\"}} {}", k, v.bytes);
    }

    println!("# HELP The current number of objects on a mako\n# TYPE object_count gauge");

    for (k, v) in accounts.iter() {
        println!("object_count{{account=\"{}\"}} {}", k, v.objects);
    }

    println!("# HELP rollup_duration_seconds Duration in seconds of the mako rollup process");
    println!(
        "# TYPE rollup_duration_seconds gauge\nrollup_duration_seconds {}",
        start.elapsed().as_secs()
    );

    let unix_time = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH);
    println!("# HELP rollup_last_run_time Last run of the mako rollup process expressed as a UNIX timestamp");
    println!(
        "# TYPE rollup_last_run_time gauge\nrollup_last_run_time {}",
        unix_time.unwrap().as_secs()
    );
}
