------------------------------ MODULE SharedStateCas ------------------------------
EXTENDS Naturals, FiniteSets

(*
  Bounded model of the shared-state publish protocol at the level SyncConvergence
  abstracts away: the individual filesystem steps of one publication.

  SyncConvergence models Publish as a single atomic action, so it can say nothing
  about how a publication is assembled. This module splits it into the steps the
  implementation actually performs:

    Sample   - SyncManager.notifyChange() reads the file to pick an expected version
    Acquire  - enter the critical section (only when Guarded)
    CasRead  - compareAndSwap() reads the on-disk version
    CasCommit- compare that read against the expected version, then write

  Environment assumptions made explicit by Spec:
  - Actors is finite and non-empty; each actor publishes at most once, which
    bounds fileVersion by the number of actors.
  - Interleaving between the steps of different actors is adversarial.
  - Guarded selects whether the read..write sequence is serialised at all.
  - HeartbeatKeepsLeaseAlive selects whether a live holder's lease can be judged
    stale by a peer while it is still inside the critical section.
  - OwnerCheckedRelease selects whether releasing verifies ownership first.
  - Each actor is fairly scheduled; contended acquisition needs strong fairness.
*)

CONSTANTS Actors, MaxVersion, NoOwner,
          Guarded, HeartbeatKeepsLeaseAlive, OwnerCheckedRelease

ASSUME /\ Actors # {}
       /\ MaxVersion \in Nat
       /\ MaxVersion >= Cardinality(Actors)
       /\ NoOwner \notin Actors
       /\ Guarded \in BOOLEAN
       /\ HeartbeatKeepsLeaseAlive \in BOOLEAN
       /\ OwnerCheckedRelease \in BOOLEAN

VARIABLES fileVersion, base, seen, phase, outcome, owner, pulse

vars == <<fileVersion, base, seen, phase, outcome, owner, pulse>>

Phases == {"idle", "sampled", "holding", "compared", "done"}
Outcomes == {"none", "written", "stale"}

Init ==
    /\ fileVersion = 0
    /\ base = [a \in Actors |-> 0]
    /\ seen = [a \in Actors |-> 0]
    /\ phase = [a \in Actors |-> "idle"]
    /\ outcome = [a \in Actors |-> "none"]
    /\ owner = NoOwner
    /\ pulse = 0

\* The publisher decides which on-disk version it intends to replace.
Sample(a) ==
    /\ phase[a] = "idle"
    /\ base' = [base EXCEPT ![a] = fileVersion]
    /\ phase' = [phase EXCEPT ![a] = "sampled"]
    /\ UNCHANGED <<fileVersion, seen, outcome, owner, pulse>>

\* Without a lock this step is a no-op, which is exactly the defect being modelled.
Acquire(a) ==
    /\ phase[a] = "sampled"
    /\ (Guarded => owner = NoOwner)
    /\ owner' = IF Guarded THEN a ELSE owner
    /\ phase' = [phase EXCEPT ![a] = "holding"]
    /\ UNCHANGED <<fileVersion, base, seen, outcome, pulse>>

\* compareAndSwap() reads the current on-disk version.
CasRead(a) ==
    /\ phase[a] = "holding"
    /\ seen' = [seen EXCEPT ![a] = fileVersion]
    /\ phase' = [phase EXCEPT ![a] = "compared"]
    /\ UNCHANGED <<fileVersion, base, outcome, owner, pulse>>

\* compareAndSwap() compares what it read against the expected version and writes.
\* The comparison uses the value read in CasRead, not the value at write time:
\* nothing re-checks the file between the two steps.
CasCommit(a) ==
    /\ phase[a] = "compared"
    /\ IF seen[a] = base[a]
         THEN /\ fileVersion' = base[a] + 1
              /\ outcome' = [outcome EXCEPT ![a] = "written"]
         ELSE /\ UNCHANGED fileVersion
              /\ outcome' = [outcome EXCEPT ![a] = "stale"]
    /\ phase' = [phase EXCEPT ![a] = "done"]
    /\ owner' = CASE ~Guarded -> owner
                  [] OwnerCheckedRelease /\ owner # a -> owner
                  [] OTHER -> NoOwner
    /\ UNCHANGED <<base, seen, pulse>>

\* A peer judges the lease stale while its holder is still working. A heartbeat
\* refreshes the lease, so this is only reachable when there is none.
Expire(a) ==
    /\ Guarded
    /\ ~HeartbeatKeepsLeaseAlive
    /\ owner = a
    /\ phase[a] \in {"holding", "compared"}
    /\ owner' = NoOwner
    /\ UNCHANGED <<fileVersion, base, seen, phase, outcome, pulse>>

\* Keeps every state with a successor so termination is not reported as deadlock.
Pulse ==
    /\ pulse' = 1 - pulse
    /\ UNCHANGED <<fileVersion, base, seen, phase, outcome, owner>>

Next ==
    \/ (\E a \in Actors : Sample(a))
    \/ (\E a \in Actors : Acquire(a))
    \/ (\E a \in Actors : CasRead(a))
    \/ (\E a \in Actors : CasCommit(a))
    \/ (\E a \in Actors : Expire(a))
    \/ Pulse

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ \A a \in Actors : WF_vars(Sample(a))
    /\ \A a \in Actors : SF_vars(Acquire(a))
    /\ \A a \in Actors : WF_vars(CasRead(a))
    /\ \A a \in Actors : WF_vars(CasCommit(a))

TypeOK ==
    /\ fileVersion \in 0..MaxVersion
    /\ base \in [Actors -> 0..MaxVersion]
    /\ seen \in [Actors -> 0..MaxVersion]
    /\ phase \in [Actors -> Phases]
    /\ outcome \in [Actors -> Outcomes]
    /\ owner \in Actors \cup {NoOwner}
    /\ pulse \in {0, 1}

InCriticalSection(a) == phase[a] \in {"holding", "compared"}

(*
  Two publishers must never both be told their write won against the same
  on-disk version. When they are, one publication was silently overwritten
  while its author went on believing it had been published.
*)
NoLostUpdate ==
    \A a \in Actors : \A b \in Actors :
        (a # b /\ outcome[a] = "written" /\ outcome[b] = "written")
            => base[a] # base[b]

(*
  A lock only excludes if at most one holder is ever inside it.
*)
MutualExclusion ==
    Guarded => Cardinality({a \in Actors : InCriticalSection(a)}) <= 1

(*
  The written version must never be lower than one already published.
*)
VersionNeverRegresses ==
    fileVersion' >= fileVersion

MonotonicVersion == [] [VersionNeverRegresses]_vars

\* No publisher is left waiting forever on the lock.
EveryPublisherFinishes == <>(\A a \in Actors : phase[a] = "done")

=============================================================================
