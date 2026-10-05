# One-time: dump live Josh Postgres on the SERVER, then copy the file to your PC.
# Run these commands on the live machine (SSH), NOT on Windows.
#
# After the file is on your PC under backups\, run:
#   npm run db:restore-live
#
# Live is never modified by restore. Local DB is replaced by the snapshot.

Write-Host @"

=== STEP A — on LIVE server (SSH into the box that runs /opt/josh) ===

  cd /opt/josh

  # Create a compressed custom-format dump inside the postgres container
  docker exec josh-postgres pg_dump -U josh -d josh -Fc -Z 6 -f /tmp/josh-live.dump

  # Copy dump out of the container onto the server disk
  docker cp josh-postgres:/tmp/josh-live.dump /opt/josh/josh-live.dump
  docker exec josh-postgres rm -f /tmp/josh-live.dump

  # Show size
  ls -lh /opt/josh/josh-live.dump

=== STEP B — copy file to your Windows PC ===

  Put the file here (create folder if needed):
    C:\Users\sahni\My Drive (amit.s@absstem.com)\Josh\backups\josh-live.dump

  Ways to copy:
  - WinSCP / FileZilla from the server
  - Or from PowerShell on PC (if OpenSSH client installed):
      scp USER@YOUR_SERVER:/opt/josh/josh-live.dump "C:\Users\sahni\My Drive (amit.s@absstem.com)\Josh\backups\josh-live.dump"

=== STEP C — on this PC, after the file is in backups\ ===

  npm run db:restore-live

  Then restart API if it was running:
    npm run dev:server

Sign in again with Google (amit.s@absstem.com). Local will now mirror live data as of the dump time.

"@
