var { DAILY_AVERAGE, DAYS, GOAL, POINT_RUBLES, TASKS, TRACKER_START_DATE } = globalThis.TRACKER_DATA;

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromIsoDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function startOfWeek(date = new Date()) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const day = result.getDay();
  result.setDate(result.getDate() - ((day + 6) % 7));
  return result;
}

function weekDates(weekStartIso) {
  const start = fromIsoDate(weekStartIso);
  return DAYS.map((_, index) => toIsoDate(addDays(start, index)));
}

function reportWeekStartsForMonth(monthKey) {
  const firstMonth = TRACKER_START_DATE.slice(0, 7);
  if (monthKey < firstMonth) return [];
  const first = fromIsoDate(`${monthKey}-01`);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12);
  const weeks = [];
  let cursor = startOfWeek(first);
  if (toIsoDate(cursor) < TRACKER_START_DATE) cursor = fromIsoDate(TRACKER_START_DATE);
  while (cursor <= last) {
    weeks.push(toIsoDate(cursor));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

function canChildEditDate(dateIso, todayIso, signed = false) {
  return dateIso >= TRACKER_START_DATE && dateIso === todayIso && !signed;
}

function canParentSignDate(dateIso, todayIso) {
  return dateIso >= TRACKER_START_DATE && dateIso < todayIso;
}

function sumValues(record = {}) {
  return Object.values(record).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function dayTotal(entries, profileId, dateIso) {
  if (dateIso < TRACKER_START_DATE) return 0;
  return sumValues(entries?.[profileId]?.[dateIso]);
}

function weekStats(entries, profileId, weekStartIso) {
  const dates = weekDates(weekStartIso);
  const daily = dates.map((date) => dayTotal(entries, profileId, date));
  let positive = 0;
  let penalties = 0;
  for (const date of dates) {
    if (date < TRACKER_START_DATE) continue;
    for (const value of Object.values(entries?.[profileId]?.[date] || {})) {
      const points = Number(value) || 0;
      if (points >= 0) positive += points;
      else penalties += Math.abs(points);
    }
  }
  const net = positive - penalties;
  return { dates, daily, positive, penalties, net, money: net * POINT_RUBLES };
}

function monthStats(entries, profileId, monthKey) {
  let positive = 0;
  let penalties = 0;
  const profileEntries = entries?.[profileId] || {};
  for (const [date, values] of Object.entries(profileEntries)) {
    if (date < TRACKER_START_DATE || !date.startsWith(monthKey)) continue;
    for (const raw of Object.values(values || {})) {
      const points = Number(raw) || 0;
      if (points >= 0) positive += points;
      else penalties += Math.abs(points);
    }
  }
  const net = positive - penalties;
  return { positive, penalties, net, money: net * POINT_RUBLES };
}

function paceStats(weekStartIso, weekNet, today = new Date()) {
  const start = fromIsoDate(weekStartIso);
  const end = addDays(start, 6);
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  let dayIndex;
  let remainingDays;
  if (todayLocal < start) {
    dayIndex = -1;
    remainingDays = 7;
  } else if (todayLocal > end) {
    dayIndex = 6;
    remainingDays = 0;
  } else {
    dayIndex = Math.round((todayLocal - start) / 86400000);
    remainingDays = 7 - dayIndex;
  }
  const left = Math.max(0, GOAL - weekNet);
  const neededPerRemainingDay = remainingDays ? left / remainingDays : null;
  const expectedByNow = dayIndex < 0 ? 0 : Math.min(GOAL, DAILY_AVERAGE * (dayIndex + 1));
  const additionalToday = remainingDays
    ? Math.max(0, Math.ceil(expectedByNow - weekNet))
    : 0;
  return { dayIndex, remainingDays, left, neededPerRemainingDay, expectedByNow, additionalToday };
}

function occurrenceCount(entries, profileId, weekStartIso, taskId) {
  return weekDates(weekStartIso).reduce((count, date) => {
    if (date < TRACKER_START_DATE) return count;
    const value = Number(entries?.[profileId]?.[date]?.[taskId]) || 0;
    return count + (value !== 0 ? 1 : 0);
  }, 0);
}

function monthlyOccurrenceCount(entries, profileId, monthKey, taskId) {
  return Object.entries(entries?.[profileId] || {}).reduce((count, [date, values]) => {
    if (date < TRACKER_START_DATE || !date.startsWith(monthKey)) return count;
    return count + ((Number(values?.[taskId]) || 0) !== 0 ? 1 : 0);
  }, 0);
}

function taskAvailability(task, dayId, entries, profileId, dateIso, weekStartIso) {
  if (!task.allowedDays.includes(dayId)) return { available: false, reason: "Недоступно в этот день" };
  const existing = Number(entries?.[profileId]?.[dateIso]?.[task.id]) || 0;
  if (existing !== 0) return { available: false, reason: "Уже заполнено" };
  if (task.weeklyLimit && occurrenceCount(entries, profileId, weekStartIso, task.id) >= task.weeklyLimit) {
    return { available: false, reason: `Лимит: ${task.weeklyLimit} раз(а) в неделю` };
  }
  if (task.monthlyLimit && monthlyOccurrenceCount(entries, profileId, dateIso.slice(0, 7), task.id) >= task.monthlyLimit) {
    return { available: false, reason: `Лимит: ${task.monthlyLimit} раз(а) в месяц` };
  }
  return { available: true, reason: "" };
}

function buildPlan(tasks, target) {
  if (target <= 0) return [];
  const sorted = [...tasks]
    .filter((task) => !task.penalty && task.suggestionEligible !== false && task.suggestedPoints > 0)
    .sort((a, b) => b.suggestedPoints - a.suggestedPoints || a.title.localeCompare(b.title, "ru"));
  const plan = [];
  let total = 0;
  for (const task of sorted) {
    plan.push(task);
    total += task.suggestedPoints;
    if (total >= target || plan.length >= 5) break;
  }
  return plan;
}

function hasThreeDayStreak(dailyTotals) {
  let streak = 0;
  for (const total of dailyTotals) {
    streak = total >= Math.ceil(DAILY_AVERAGE) ? streak + 1 : 0;
    if (streak >= 3) return true;
  }
  return false;
}

function getAchievements(stats, pace, fourWeekTotals = []) {
  return [
    { id: "pace", title: "Отличный темп", description: "Три дня подряд по 8+ баллов", unlocked: hasThreeDayStreak(stats.daily) },
    { id: "ahead", title: "На шаг впереди", description: "Опережение недельного ориентира на 5 баллов", unlocked: stats.net >= pace.expectedByNow + 5 },
    { id: "close", title: "Финиш близко", description: "До цели осталось меньше 10 баллов", unlocked: stats.net >= 46 && stats.net < GOAL },
    { id: "goal", title: "55+", description: "Недельная цель достигнута", unlocked: stats.net >= GOAL },
    { id: "stable", title: "Стабильность", description: "Четыре недели подряд по 55+ баллов", unlocked: fourWeekTotals.length === 4 && fourWeekTotals.every((value) => value >= GOAL) },
  ];
}

function validatePoints(task, rawValue) {
  if (rawValue === "" || rawValue === null || rawValue === undefined) return { valid: true, value: 0 };
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return { valid: false, message: "Введите число" };
  if (value < task.min || value > task.max) {
    return { valid: false, message: `Допустимо от ${task.min} до ${task.max}` };
  }
  return { valid: true, value };
}

function availableTasksForDay(entries, profileId, dateIso, weekStartIso, tasks = TASKS) {
  const index = weekDates(weekStartIso).indexOf(dateIso);
  const dayId = DAYS[Math.max(0, index)]?.id;
  return tasks.filter((task) => taskAvailability(task, dayId, entries, profileId, dateIso, weekStartIso).available);
}

globalThis.TRACKER_LOGIC = {
  toIsoDate,
  fromIsoDate,
  addDays,
  startOfWeek,
  weekDates,
  reportWeekStartsForMonth,
  canChildEditDate,
  canParentSignDate,
  sumValues,
  dayTotal,
  weekStats,
  monthStats,
  paceStats,
  occurrenceCount,
  monthlyOccurrenceCount,
  taskAvailability,
  buildPlan,
  hasThreeDayStreak,
  getAchievements,
  validatePoints,
  availableTasksForDay,
};
