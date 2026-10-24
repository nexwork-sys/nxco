// India Standard Time is a fixed UTC+5:30 offset (no daylight saving), so
// we can derive it directly from the UTC clock — this keeps every
// attendance date/time correct regardless of what timezone the server
// itself runs in (most hosts default to UTC).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** A Date object whose UTC-formatted fields read as IST wall-clock time. */
function nowIST() {
    return new Date(Date.now() + IST_OFFSET_MS);
}

/** Today's date in IST, as 'YYYY-MM-DD'. */
function todayIST() {
    return nowIST().toISOString().slice(0, 10);
}

/** Current time in IST, as 'HH:MM:SS'. */
function nowTimeIST() {
    return nowIST().toISOString().slice(11, 19);
}

module.exports = { nowIST, todayIST, nowTimeIST };
