# 0008. Job state lives in the translation note

- Status: Accepted
- Date: 2026-10-04

## Context

Translating a long article takes many minutes and dozens of model calls. The job must be cancellable, resumable after a crash or restart, and must write its results incrementally. Progress could be kept in plugin data, in a sidecar file, or in the translation note itself. ADR 0001 already keeps alignment out of plugin data so that it syncs and survives uninstall.

## Decision

A job's remaining work is recorded as Menard lines in the translation note: `%%menard:1 p12 translate%%` where a unit's translation will go, and `%%menard:1 p12 align%%` where a unit's sentence map is still to be made. Translate note first writes a skeleton holding one marker per unit; each finished unit replaces its own marker in a single atomic write. Running the same command again processes whatever markers remain. No job state is stored anywhere else.

## Consequences

- Resume needs no bookkeeping, works across restarts and devices, and is visible in the note.
- Cancelling or crashing loses only the units in flight.
- A partially translated note is readable: finished units align, pending ones show a hidden marker.
- Results can arrive out of order without affecting the final layout, since each lands in its own marker's place.
- Markers are Menard-owned lines, hidden in Live Preview and invisible in reading view, like maps.
