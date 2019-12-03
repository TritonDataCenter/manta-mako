use std::collections::HashMap;
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
            let account_uuid = &entry.path().parent().unwrap().to_str().unwrap()[7..];

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

    println!("# HELP used_bytes The current number of bytes used on a mako\n# TYPE used_bytes gauge");

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