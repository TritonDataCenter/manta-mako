use std::env;
use std::fs;
use std::io::{self, BufReader};
use std::io::prelude::*;
use std::time;
use std::process;

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();

    let records_file_path = &args[1];
    let records_file = fs::File::open(records_file_path)?;
    let records = BufReader::new(records_file);

    let bytes_processed_file_path = "/var/tmp/bytes_processed";
    let mut bytes_processed_file = fs::OpenOptions::new().append(true).open(bytes_processed_file_path)?;

    let storage_id = &args[2].clone();
    let mut total_bytes_processed = args[3].parse::<u64>().unwrap();

    for line in records.lines() {
        let line_val = line.unwrap();
        println!("Processing {}", line_val);

        let line_cols: Vec<&str> = line_val.split_whitespace().collect();

        if line_cols[1] != storage_id { continue; }

        let object = format!("/manta/{}/{}", line_cols[2], line_cols[3]);
        let mut object_bytes = 0;
        if let Ok(md) = fs::metadata(&object) { object_bytes += md.len() }
        total_bytes_processed += object_bytes;

        let sys_time = time::SystemTime::now().duration_since(time::SystemTime::UNIX_EPOCH).unwrap();
        let pid = process::id();

        let sys_time_secs = sys_time.as_secs();
        let cur_logical_bytes = format!("{}: mako_gc.sh ({}) current logical bytes processed: {}\n", sys_time_secs, pid, object_bytes);
        let total_logical_bytes = format!("{}: mako_gc.sh ({}) total logical bytes deleted: {}\n", sys_time_secs, pid, total_bytes_processed);
        let cur_physical_bytes = format!("{}: mako_gc.sh ({}) current physical bytes processed: 0\n", sys_time_secs, pid);
        let total_physical_bytes = format!("{}: mako_gc.sh ({}) total physical bytes deleted: 0\n", sys_time_secs, pid);

        bytes_processed_file.write_all(cur_logical_bytes.as_bytes())?;
        bytes_processed_file.write_all(total_logical_bytes.as_bytes())?;
        bytes_processed_file.write_all(cur_physical_bytes.as_bytes())?;
        bytes_processed_file.write_all(total_physical_bytes.as_bytes())?;

        match fs::remove_file(object) {
            Ok(v) => v,
            Err(e) => println!("{}", e),
        }
    }

    Ok(())
}