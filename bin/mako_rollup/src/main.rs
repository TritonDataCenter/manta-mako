use std::collections::HashMap;
use std::time::{Duration, Instant};
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

    println!("# HELP mako_used_bytes The current number of bytes used on a mako\n# TYPE mako_used_bytes gauge");

    for (k, v) in accounts.iter() {
        println!("mako_used_bytes{{account=\"{}\"}} {}", k, v.bytes);
    }

    println!("# HELP mako_object_count The current number of objects on a mako\n# TYPE mako_object_count gauge");

    for (k, v) in accounts.iter() {
        println!("mako_object_count{{account=\"{}\"}} {}", k, v.objects);
    }

    println!("# HELP mako_rollup_duration_seconds Duration in seconds of the mako rollup process");
    println!(
        "# TYPE mako_rollup_duration_seconds gauge\nmako_rollup_duration_seconds {}",
        start.elapsed().as_secs()
    );
}