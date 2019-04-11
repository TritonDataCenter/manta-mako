use std::env;
use std::fs;
use std::io::{self, BufReader};
use std::io::prelude::*;
use std::time;
use std::process;
use std::path::Path;

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();

    /*
     * It is likely that we will encounter a path to a record file that does not exist. In these cases we
     * need to bail out of the program and let the wrapping shell script delete the file.
     */
    let records_file_path = &args[1];
    if !Path::new(&records_file_path).exists() {
        println!("Record file: {} did not exist", records_file_path);
        process::exit(0);
    }

    let records_file = fs::File::open(records_file_path)?;
    let records = BufReader::new(records_file);

    let bytes_processed_file_path = "/var/tmp/bytes_processed";
    let mut bytes_processed_file = fs::OpenOptions::new().append(true).open(bytes_processed_file_path)?;

    let storage_id = &args[2].clone();
    let mut total_bytes_processed = args[3].parse::<u64>().unwrap();

    /*
     * If we encounter an invalid instruction we set this to true so that when we're done processing the
     * current file, we can return a non-zero exit code and signal to mako_gc.sh that the current
     * instruction file should be preserved for later analysis.
     */
    let mut invalid_instruction_seen = false;

    for line in records.lines() {
        let line_val = line.unwrap();
        println!("Processing {}", line_val);

        let line_cols: Vec<&str> = line_val.split_whitespace().collect();

        /*
         * Due to a bug in manta-garbage-collector it is possible that we will encounter invalid
         * instructions. If we do encounter an invalid instruction it is important that we preserve
         * the original instruction file for postmortem analysis. Here we check that the line has
         * the correct number of values and if not we log the invalid line, set invalid_instruction_seen
         * to true and skip to the next instruction.
         */
        if line_cols.len() < 4 {
            println!("Encountered invalid instruction {}", line_val);
            invalid_instruction_seen = true;
            continue;
        }

        if line_cols[1] != storage_id { continue; }

        /*
         * Sometimes we will encounter a situation where the object to be deleted has already been deleted.
         * In these cases we want to output that this happened and move forward without doing anything more
         * since this is an expected case.
         */
        let object = format!("/manta/{}/{}", line_cols[2], line_cols[3]);
        if !Path::new(&object).exists() {
            println!("Object: {} did not exist", object);
            continue; 
        }

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

        fs::remove_file(object)?;
    }

    if invalid_instruction_seen { process::exit(1); }

    Ok(())
}