// This project lives under ~/Desktop, which macOS syncs to iCloud Drive by
// default. iCloud's file-provider layer intercepts file access for anything
// it's tracking, and node_modules (tens of thousands of small files) makes
// build tools that scan it (tsc, vite) hang or throw "Stale NFS file handle".
// The `com.apple.fileprovider.ignore#P` xattr tells iCloud to leave a folder
// alone. It doesn't survive node_modules being deleted/recreated, so this
// reapplies it after every install.
import { execFile } from "node:child_process";

if (process.platform === "darwin") {
  execFile("xattr", ["-w", "com.apple.fileprovider.ignore#P", "1", "node_modules"], (error) => {
    if (error) console.warn("Could not exclude node_modules from iCloud sync:", error.message);
  });
}
