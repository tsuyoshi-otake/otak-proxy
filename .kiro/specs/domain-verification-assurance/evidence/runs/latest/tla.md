# TLC Result

- TLC command: C:\Users\developer\AppData\Local\Programs\TLAplus\tlc.cmd
- Exploration: breadth-first, workers=1, fp=0; each run uses its recorded fixed seed.
- All expected outcomes passed: true

| Run | Expected | Result | Seed | Generated / distinct | Diameter | Deadlock |
| --- | --- | --- | ---: | ---: | ---: | --- |
| TLC-LIFECYCLE-SMALL | Safety/Liveness/deadlock pass | passed | 2026081501 | 249 / 94 | 11 | false |
| TLC-LIFECYCLE-MEDIUM | Safety/Liveness/deadlock pass | passed | 2026081502 | 59777 / 13476 | 25 | false |
| TLC-LIFECYCLE-REQUIRED-APPLIED | Expected NeverApplied trace | passed | 2026081503 | 10 / 8 | 4 | false |
| TLC-SYNC-RELIABLE-SMALL | Safety/Liveness/deadlock pass | passed | 2026081511 | 189 / 64 | 6 | false |
| TLC-SYNC-RELIABLE-MEDIUM | Safety/Liveness/deadlock pass | passed | 2026081512 | 489 / 146 | 8 | false |
| TLC-SYNC-LOSS-BOUNDARY | Expected ConvergedWhenQuiescent trace | passed | 2026081513 | 6 / 6 | 3 | false |
| TLC-SYNC-DIVERGENCE-REACHABILITY | Expected NeverPublishedDivergence trace | passed | 2026081514 | 2 / 2 | 2 | false |
| TLC-CAS-UNGUARDED-LOST-UPDATE | Expected NoLostUpdate trace | passed | 2026090801 | 127 / 59 | 9 | false |
| TLC-CAS-GUARDED | Safety/Liveness/deadlock pass | passed | 2026090802 | 129 / 60 | 10 | false |
| TLC-CAS-LEASE-ABA | Expected MutualExclusion trace | passed | 2026090803 | 65 / 36 | 6 | false |
