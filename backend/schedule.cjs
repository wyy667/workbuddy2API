'use strict';
function localDay(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function scheduledDue(now, at, lastAt, everyDays = 1) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(at || '');
  if (!match || +match[1] > 23 || +match[2] > 59) return false;
  const target = new Date(now); target.setHours(+match[1], +match[2], 0, 0);
  if (now < target) return false;
  if (!lastAt) return true;
  const last = new Date(lastAt);
  const dayDistance = (Date.UTC(now.getFullYear(),now.getMonth(),now.getDate())-Date.UTC(last.getFullYear(),last.getMonth(),last.getDate())) / 86400000;
  return dayDistance >= Math.max(1, everyDays);
}
module.exports = { scheduledDue, localDay };
