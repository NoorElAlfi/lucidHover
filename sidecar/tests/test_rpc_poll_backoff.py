"""
Session 75: queue-aware adaptive poll backoff for the sidecar's RPC
dispatch loop. Pure-logic tests only -- no real sidecar spawn needed, since
`_ActivityTracker`/`_poll_interval` are deliberately factored out of
`_serve_windows`/`_serve_posix` so they're testable in isolation (see
rpc_server.py's own comments on both).

The live idle-CPU measurement and interactive-latency confirmation this
session's design also required are real, but not repeatable as a fast unit
test (they spawn a real sidecar process and run for minutes) -- see this
session's artifact, .claude/sessions/session-75-*.md, for those numbers.
"""

from __future__ import annotations

from sidecar.rpc_server import _IDLE_GRACE_S, _IDLE_POLL_INTERVAL_S, _POLL_INTERVAL_S, _ActivityTracker, _poll_interval


def test_poll_interval_is_fast_while_in_flight():
    assert _poll_interval(in_flight=1, out_queue_empty=True, seconds_since_active=999.0) == _POLL_INTERVAL_S


def test_poll_interval_is_fast_while_queue_nonempty_even_with_zero_in_flight():
    assert _poll_interval(in_flight=0, out_queue_empty=False, seconds_since_active=999.0) == _POLL_INTERVAL_S


def test_poll_interval_is_fast_during_the_grace_window_after_work_ends():
    assert _poll_interval(in_flight=0, out_queue_empty=True, seconds_since_active=_IDLE_GRACE_S - 0.01) == _POLL_INTERVAL_S


def test_poll_interval_is_slow_once_past_the_grace_window():
    assert (
        _poll_interval(in_flight=0, out_queue_empty=True, seconds_since_active=_IDLE_GRACE_S + 0.01)
        == _IDLE_POLL_INTERVAL_S
    )


def test_poll_interval_boundary_at_exactly_the_grace_window_is_still_fast():
    # `< _IDLE_GRACE_S`, not `<=` -- the exact boundary instant counts as
    # still within the grace window, matching the "less than" wording this
    # session's own design settled on rather than an off-by-one either way.
    assert _poll_interval(in_flight=0, out_queue_empty=True, seconds_since_active=_IDLE_GRACE_S) == _IDLE_POLL_INTERVAL_S


class _FakeClock:
    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


def test_activity_tracker_starts_with_zero_in_flight_and_zero_elapsed():
    clock = _FakeClock(100.0)
    tracker = _ActivityTracker(clock=clock)
    in_flight, elapsed = tracker.snapshot()
    assert in_flight == 0
    assert elapsed == 0.0


def test_activity_tracker_mark_submitted_increments_in_flight():
    clock = _FakeClock(100.0)
    tracker = _ActivityTracker(clock=clock)
    tracker.mark_submitted()
    tracker.mark_submitted()
    in_flight, _ = tracker.snapshot()
    assert in_flight == 2


def test_activity_tracker_mark_completed_decrements_in_flight():
    clock = _FakeClock(100.0)
    tracker = _ActivityTracker(clock=clock)
    tracker.mark_submitted()
    tracker.mark_submitted()
    tracker.mark_completed()
    in_flight, _ = tracker.snapshot()
    assert in_flight == 1


def test_activity_tracker_elapsed_grows_with_the_clock_after_the_last_activity():
    clock = _FakeClock(100.0)
    tracker = _ActivityTracker(clock=clock)
    tracker.mark_submitted()
    tracker.mark_completed()  # last activity at t=100
    clock.now = 105.0
    _, elapsed = tracker.snapshot()
    assert elapsed == 5.0


def test_activity_tracker_mark_drained_refreshes_last_active_even_with_zero_in_flight():
    """The gap this method exists to close: a worker can finish (in_flight
    back to 0) while its response still sits unread in out_queue -- the I/O
    thread must not treat that as 'idle since the submit' once it actually
    drains the queue a while later."""
    clock = _FakeClock(100.0)
    tracker = _ActivityTracker(clock=clock)
    tracker.mark_submitted()
    tracker.mark_completed()  # in_flight back to 0 at t=100
    clock.now = 101.5
    tracker.mark_drained()  # I/O thread actually reads the response at t=101.5
    clock.now = 102.0
    in_flight, elapsed = tracker.snapshot()
    assert in_flight == 0
    assert elapsed == 0.5


def test_activity_tracker_snapshot_feeds_poll_interval_correctly_end_to_end():
    clock = _FakeClock(0.0)
    tracker = _ActivityTracker(clock=clock)
    # Fully idle from the start, well past the grace window.
    clock.now = _IDLE_GRACE_S + 10.0
    in_flight, elapsed = tracker.snapshot()
    assert _poll_interval(in_flight, out_queue_empty=True, seconds_since_active=elapsed) == _IDLE_POLL_INTERVAL_S

    # A request arrives: submitted, still running.
    tracker.mark_submitted()
    in_flight, elapsed = tracker.snapshot()
    assert _poll_interval(in_flight, out_queue_empty=True, seconds_since_active=elapsed) == _POLL_INTERVAL_S

    # It completes; still within the grace window immediately after.
    tracker.mark_completed()
    in_flight, elapsed = tracker.snapshot()
    assert _poll_interval(in_flight, out_queue_empty=True, seconds_since_active=elapsed) == _POLL_INTERVAL_S

    # Enough idle time passes without further activity.
    clock.now += _IDLE_GRACE_S + 1.0
    in_flight, elapsed = tracker.snapshot()
    assert _poll_interval(in_flight, out_queue_empty=True, seconds_since_active=elapsed) == _IDLE_POLL_INTERVAL_S
