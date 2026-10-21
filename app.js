var { CATEGORIES, DAILY_AVERAGE, DAYS, GOAL, MONTH_BONUS, MONTH_GOAL, SOURCE_AMBIGUITIES, TASKS, TRACKER_START_DATE } = globalThis.TRACKER_DATA;
var { addDays, availableTasksForDay, buildPlan, canChildEditDate, canParentSignDate, fromIsoDate, getAchievements, monthStats, paceStats, reportWeekStartsForMonth, startOfWeek, taskAvailability, toIsoDate, validatePoints, weekDates, weekStats } = globalThis.TRACKER_LOGIC;

const todayIso = toIsoDate(new Date());
const firstMonth = TRACKER_START_DATE.slice(0, 7);
const currentWeekStart = toIsoDate(startOfWeek(new Date()));
const initialWeekStart = currentWeekStart < TRACKER_START_DATE ? TRACKER_START_DATE : currentWeekStart;
const initialDate = todayIso < TRACKER_START_DATE ? TRACKER_START_DATE : todayIso;
const initialMonth = todayIso.slice(0, 7) < firstMonth ? firstMonth : todayIso.slice(0, 7);
let backend = null;
let authUser = null;
let authContext = null;
let authSubscription = null;
let realtimeStarted = false;
let refreshing = false;
let scoreSaveCount = 0;
let deferredServerRefresh = false;

function defaultState() {
  return {
    version: 3,
    profiles: [], entries: {}, signoffs: {}, bonuses: {},
    ui: { role: "child", viewMode: "day", parentViewMode: "month", selectedProfileId: "", selectedWeekStart: initialWeekStart, selectedDate: initialDate, selectedMonth: initialMonth },
  };
}

let state = defaultState();
const formatDateShort = (iso) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(fromIsoDate(iso));
const formatWeek = (startIso) => { const dates = weekDates(startIso); return `${formatDateShort(dates[0])} — ${formatDateShort(dates[6])}`; };
const formatMonth = (monthKey) => new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(fromIsoDate(`${monthKey}-01`));
const formatMoney = (value) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(value);
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const selectedProfile = () => state.profiles.find((profile) => profile.id === state.ui.selectedProfileId) || state.profiles[0];
const isSigned = (profileId, dateIso) => Boolean(state.signoffs?.[profileId]?.[dateIso]);
const canChildEdit = (profileId, dateIso) => canChildEditDate(dateIso, todayIso, isSigned(profileId, dateIso));
const signButtonDisabled = (profileId, dateIso) => !isSigned(profileId, dateIso) && !canParentSignDate(dateIso, todayIso);
const signButtonText = (profileId, dateIso, long = false) => {
  if (isSigned(profileId, dateIso)) return "Подписано ✓";
  if (dateIso > todayIso) return long ? "День впереди" : "Впереди";
  if (dateIso === todayIso) return long ? "Подписать завтра" : "Завтра";
  return long ? "Подписать день" : "Подписать";
};

function normalizeUiPeriod() {
  if (state.ui.selectedWeekStart < TRACKER_START_DATE) state.ui.selectedWeekStart = TRACKER_START_DATE;
  if (state.ui.selectedDate < TRACKER_START_DATE) state.ui.selectedDate = TRACKER_START_DATE;
  if ((state.ui.selectedMonth || firstMonth) < firstMonth) state.ui.selectedMonth = firstMonth;
}

function motivation(net) {
  if (net >= GOAL) return "Цель достигнута. Можно продолжать сверх 55!";
  if (net >= 45) return "Финиш близко — осталось совсем немного.";
  if (net >= 35) return "Больше половины пути уже пройдено.";
  if (net >= 20) return "Темп растёт. Продолжай в том же духе.";
  return "Начало положено. Каждый балл двигает к цели.";
}

function currentFourWeekTotals(profileId, weekStartIso) {
  return [3, 2, 1, 0].map((offset) => weekStats(state.entries, profileId, toIsoDate(addDays(fromIsoDate(weekStartIso), -7 * offset))).net);
}

function weeksForMonth(monthKey) {
  return reportWeekStartsForMonth(monthKey);
}

function monthlyGoalWeeks(profileId, monthKey) {
  const totals = weeksForMonth(monthKey).map((weekStart) => ({ weekStart, total: weekStats(state.entries, profileId, weekStart).net }));
  return { totals, qualified: totals.filter((item) => item.total >= GOAL).length };
}

const bonusRecord = (profileId, monthKey) => state.bonuses?.[profileId]?.[monthKey] || null;

function weekResultLabel(total) {
  if (total > GOAL) return "Цель выполнена";
  if (total === GOAL) return "Ровно цель";
  return `Не хватило ${GOAL - total}`;
}

function planMarkup(items, emptyText) {
  if (!items.length) return `<p class="muted small">${escapeHtml(emptyText)}</p>`;
  return `<ul class="plan-list">${items.map((task) => `<li><span>${escapeHtml(task.title)}</span><span class="plan-points">+${task.suggestedPoints}</span></li>`).join("")}</ul>`;
}

function profileOptionsMarkup(profile) {
  return state.profiles.map((item) => `<option value="${item.id}" ${item.id === profile.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
}

function renderRoleSwitch() {
  const switcher = document.querySelector("#roleSwitch");
  if (authContext?.role !== "parent") {
    switcher.classList.add("hidden");
    switcher.innerHTML = "";
    return;
  }
  switcher.innerHTML = `${state.profiles.map((profile) => `<button class="role-button ${state.ui.role === "parentEdit" && state.ui.selectedProfileId === profile.id ? "active" : ""}" type="button" data-child-profile="${profile.id}">${escapeHtml(profile.name)}</button>`).join("")}<button class="role-button ${state.ui.role === "parent" ? "active" : ""}" type="button" data-role="parent">Обзор родителя</button>`;
  switcher.classList.remove("hidden");
}

function renderChild() {
  const profile = selectedProfile();
  const isParentEdit = state.ui.role === "parentEdit";
  state.ui.selectedProfileId = profile.id;
  const dates = weekDates(state.ui.selectedWeekStart);
  if (!dates.includes(state.ui.selectedDate)) state.ui.selectedDate = dates.includes(todayIso) ? todayIso : dates[0];
  const selectedIndex = dates.indexOf(state.ui.selectedDate);
  const day = DAYS[selectedIndex];
  const stats = weekStats(state.entries, profile.id, state.ui.selectedWeekStart);
  const pace = paceStats(state.ui.selectedWeekStart, stats.net);
  const available = availableTasksForDay(state.entries, profile.id, state.ui.selectedDate, state.ui.selectedWeekStart);
  const minimumTarget = pace.additionalToday;
  const superTarget = minimumTarget + Math.ceil(DAILY_AVERAGE);
  const minimumPlan = buildPlan(available, minimumTarget);
  const superPlan = buildPlan(available, superTarget);
  const progress = Math.min(100, Math.max(0, (stats.net / GOAL) * 100));
  const neededRate = pace.neededPerRemainingDay === null ? "Неделя завершена" : `${pace.neededPerRemainingDay.toFixed(1).replace(".", ",")} балла/день`;
  const achievements = getAchievements(stats, pace, currentFourWeekTotals(profile.id, state.ui.selectedWeekStart));
  const monthKey = state.ui.selectedDate.slice(0, 7);
  const month = monthStats(state.entries, profile.id, monthKey);
  const monthWeeks = monthlyGoalWeeks(profile.id, monthKey);
  const bonus = bonusRecord(profile.id, monthKey);

  document.querySelector("#childView").innerHTML = `
    ${isParentEdit ? `<div class="parent-edit-banner"><div><strong>Режим родителя</strong><span>Можно исправлять любые дни и недели.</span></div><button class="button secondary" id="backToParent" type="button">Вернуться к обзору</button></div>` : ""}
    <div class="toolbar">
      <select class="select" id="profileSelect" aria-label="Выберите профиль">${profileOptionsMarkup(profile)}</select>
      <div class="week-controls"><button class="week-arrow" type="button" data-week="-1" aria-label="Предыдущая неделя">←</button><span class="week-label">${formatWeek(state.ui.selectedWeekStart)}</span><button class="week-arrow" type="button" data-week="1" aria-label="Следующая неделя">→</button></div>
    </div>
    <div class="hero-grid">
      <article class="card progress-card"><div class="card-heading"><span class="goal-badge">Цель 55+</span><span class="muted small">${formatMoney(stats.money)}</span></div><div class="score">${stats.net}<span> / ${GOAL} баллов</span></div><div class="progress-track" aria-label="${Math.round(progress)} процентов цели"><div class="progress-fill" style="width:${progress}%"></div></div><p class="motivation">${motivation(stats.net)}</p></article>
      <article class="card metric-card"><div><div class="metric-label">Осталось до цели</div><div class="metric-value">${Math.max(0, GOAL - stats.net)}</div></div><div><div class="metric-label">Темп на оставшиеся дни</div><div class="metric-value">${neededRate}</div></div><div class="small muted">Средний ориентир: ${DAILY_AVERAGE.toFixed(2).replace(".", ",")} балла в день</div></article>
    </div>
    ${bonus && !isParentEdit ? `<section class="bonus-award-banner" aria-label="Начисленная премия"><div><p class="eyebrow">Итоги месяца</p><h2>Премия за месяц начислена!</h2><p>${formatMonth(monthKey)} · <strong>+${formatMoney(bonus.amount)}</strong></p></div><div class="bonus-total"><span>Всего за месяц</span><strong>${formatMoney(month.money + bonus.amount)}</strong><small>${formatMoney(month.money)} за баллы + ${formatMoney(bonus.amount)} премия</small></div></section>` : ""}
    ${isParentEdit ? "" : `<section class="plans" aria-label="Планы на день"><article class="card plan-card minimum"><p class="eyebrow">Минимум</p><h2>${minimumTarget ? `Набрать ещё ${minimumTarget}` : "Темп удержан"}</h2><p class="muted small">План закрывает отставание от равномерного недельного ориентира.</p>${planMarkup(minimumPlan, minimumTarget ? "На этот день недостаточно доступных заданий." : "Сегодня уже достаточно баллов для текущего темпа.")}</article><article class="card plan-card super"><p class="eyebrow">Супердень</p><h2>Цель: ещё ${superTarget}</h2><p class="muted small">Минимум плюс запас на один средний день. Это подсказка, а не новое правило начисления.</p>${planMarkup(superPlan, "На этот день недостаточно доступных заданий.")}</article></section>`}
    <section class="card tracker-card">
      <div class="tracker-heading section-heading"><div><p class="eyebrow">Ввод баллов</p><h2>${state.ui.viewMode === "day" ? `${day.name}, ${formatDateShort(state.ui.selectedDate)}` : "Вся неделя"}</h2>${state.ui.viewMode === "day" && isSigned(profile.id, state.ui.selectedDate) ? `<p class="signed-note">Родитель подтвердил этот день</p>` : ""}</div><div class="view-switch" aria-label="Вид таблицы"><button type="button" data-view="day" class="view-button ${state.ui.viewMode === "day" ? "active" : ""}">Один день</button><button type="button" data-view="week" class="view-button ${state.ui.viewMode === "week" ? "active" : ""}">Вся неделя</button></div></div>
      ${state.ui.viewMode === "day" ? dayTrackerMarkup(profile, day, dates, stats, isParentEdit) : weekTrackerMarkup(profile, dates, stats, isParentEdit)}
    </section>
    <div class="bottom-grid">
      <section class="card padded"><p class="eyebrow">Достижения</p><h2>Личная коллекция</h2><div class="achievement-list">${achievements.map((item) => `<div class="achievement ${item.unlocked ? "unlocked" : ""}"><div class="achievement-icon">${item.unlocked ? "★" : "○"}</div><div><strong>${item.title}</strong><span>${item.description}</span></div></div>`).join("")}</div></section>
      <section class="card padded"><p class="eyebrow">Календарный месяц</p><h2>${formatMonth(monthKey)}</h2><div class="money-line"><span>Баллы</span><strong>${month.net} / ${MONTH_GOAL}</strong></div><div class="money-line"><span>Заработано за баллы</span><strong>${formatMoney(month.money)}</strong></div><div class="money-line"><span>Недели по 55+</span><strong>${monthWeeks.qualified}</strong></div><div class="money-line"><span>Премия</span><strong>${bonus ? `+${formatMoney(bonus.amount)}` : "не начислена"}</strong></div><div class="money-line month-grand-total"><span>Всего к выплате</span><strong>${formatMoney(month.money + (bonus?.amount || 0))}</strong></div><p class="rule-info">Премию ${formatMoney(MONTH_BONUS)} родитель начисляет вручную по итогам месяца.</p></section>
    </div>`;
}

function dayTrackerMarkup(profile, day, dates, stats, isParentEdit) {
  const canEdit = isParentEdit || canChildEdit(profile.id, state.ui.selectedDate);
  const lockMessage = !canEdit && !isParentEdit ? (isSigned(profile.id, state.ui.selectedDate) ? "День подтверждён родителем и закрыт для изменений." : "Прошлые и будущие дни может исправлять только родитель.") : "";
  return `<div class="day-tabs" role="tablist">${dates.map((date, index) => `<button class="day-tab ${date === state.ui.selectedDate ? "active" : ""}" type="button" data-date="${date}" role="tab"><strong>${DAYS[index].short}${isSigned(profile.id, date) ? " ✓" : ""}</strong><span>${formatDateShort(date)} · ${stats.daily[index]}</span></button>`).join("")}</div>${lockMessage ? `<div class="lock-message">${lockMessage}</div>` : ""}<div class="task-list">${CATEGORIES.map((category) => `<section class="category"><h3 class="category-title">${category.title}</h3>${TASKS.filter((task) => task.category === category.id).map((task) => taskRowMarkup(task, day, profile.id, state.ui.selectedDate, canEdit)).join("")}</section>`).join("")}</div>`;
}

function taskRowMarkup(task, day, profileId, dateIso, canEdit) {
  const value = state.entries?.[profileId]?.[dateIso]?.[task.id] ?? "";
  const availability = taskAvailability(task, day.id, state.entries, profileId, dateIso, state.ui.selectedWeekStart);
  const blocked = !task.allowedDays.includes(day.id) || (!availability.available && Number(value || 0) === 0);
  const note = [task.note, task.weeklyLimit ? `Лимит: ${task.weeklyLimit} раз(а) в неделю.` : "", task.monthlyLimit ? `Лимит: ${task.monthlyLimit} раз(а) в месяц.` : ""].filter(Boolean).join(" ");
  return `<div class="task-row ${blocked ? "blocked" : ""} ${task.penalty ? "penalty" : ""}"><div><p class="task-title">${escapeHtml(task.title)}</p><p class="task-meta"><span class="task-points">${escapeHtml(task.pointsLabel)} балла</span>${note ? ` · ${escapeHtml(note)}` : ""}</p></div>${scoreCellMarkup(task, profileId, dateIso, value, blocked, canEdit, availability.reason)}</div>`;
}

function scoreCellMarkup(task, profileId, dateIso, value, blocked, canEdit, reason = "") {
  if (blocked) return `<div class="blocked-cell" title="${escapeHtml(reason)}">×</div>`;
  if (!canEdit) return `<div class="read-cell">${value === "" ? "—" : value}</div>`;
  return `<div><input class="score-input" inputmode="decimal" type="text" pattern="-?[0-9]*" enterkeyhint="done" autocomplete="off" min="${task.min}" max="${task.max}" value="${value}" data-saved-value="${value}" data-profile="${profileId}" data-task="${task.id}" data-date="${dateIso}" aria-label="Баллы: ${escapeHtml(task.title)}" placeholder="0" /><span class="task-error" data-error="${task.id}-${dateIso}"></span></div>`;
}

function weekTrackerMarkup(profile, dates, stats, isParentEdit) {
  return `<div class="week-table-wrap"><table class="week-table"><thead><tr><th class="task-column">Задание</th>${dates.map((date, index) => `<th>${DAYS[index].short}<small>${formatDateShort(date)}</small><b>${stats.daily[index]}</b></th>`).join("")}</tr></thead><tbody>${CATEGORIES.map((category) => `<tr class="week-category"><th colspan="8">${category.title}</th></tr>${TASKS.filter((task) => task.category === category.id).map((task) => `<tr><th class="task-column"><span>${escapeHtml(task.title)}</span><small>${escapeHtml(task.pointsLabel)} балла</small></th>${dates.map((date, index) => { const value = state.entries?.[profile.id]?.[date]?.[task.id] ?? ""; const availability = taskAvailability(task, DAYS[index].id, state.entries, profile.id, date, state.ui.selectedWeekStart); const blocked = !task.allowedDays.includes(DAYS[index].id) || (!availability.available && Number(value || 0) === 0); const canEdit = isParentEdit || canChildEdit(profile.id, date); return `<td>${scoreCellMarkup(task, profile.id, date, value, blocked, canEdit, availability.reason)}</td>`; }).join("")}</tr>`).join("")}`).join("")}</tbody></table></div>`;
}

function renderParent() {
  const profile = selectedProfile();
  const mode = state.ui.parentViewMode || "month";
  const monthKey = state.ui.selectedMonth || todayIso.slice(0, 7);
  const modeSwitch = `<div class="parent-view-switch" aria-label="Вид родительского обзора"><button class="view-button ${mode === "month" ? "active" : ""}" type="button" data-parent-view="month">Месяц</button><button class="view-button ${mode === "week" ? "active" : ""}" type="button" data-parent-view="week">Неделя</button></div>`;
  const profilePicker = `<div class="parent-profile-picker"><label for="parentProfileSelect"><span>Выбранный ребёнок</span><strong>${escapeHtml(profile.name)}</strong></label><select class="select" id="parentProfileSelect" aria-label="Выберите ребёнка">${profileOptionsMarkup(profile)}</select></div>`;
  if (mode === "week") {
    const weekStart = state.ui.selectedWeekStart;
    document.querySelector("#parentView").innerHTML = `${profilePicker}<div class="parent-overview-head"><div><p class="eyebrow">Подробный обзор</p><h2>${formatWeek(weekStart)}</h2></div>${modeSwitch}<div class="week-controls"><button class="week-arrow" type="button" data-week="-1" aria-label="Предыдущая неделя">←</button><button class="week-arrow" type="button" data-week="1" aria-label="Следующая неделя">→</button></div></div><div class="parent-grid">${parentWeekCardMarkup(profile, weekStart)}</div>${profileManagerMarkup(profile)}`;
    return;
  }
  document.querySelector("#parentView").innerHTML = `${profilePicker}<div class="parent-overview-head"><div><p class="eyebrow">Обзор месяца</p><h2>${formatMonth(monthKey)}</h2></div>${modeSwitch}<div class="month-controls"><button class="week-arrow" type="button" data-month="-1" aria-label="Предыдущий месяц">←</button><span>Месяц</span><button class="week-arrow" type="button" data-month="1" aria-label="Следующий месяц">→</button></div></div>${parentMonthMarkup(profile, monthKey)}${profileManagerMarkup(profile)}`;
}

function profileManagerMarkup(profile) {
  return `<section class="card profile-manager"><p class="eyebrow">Профиль</p><h2>Настройка: ${escapeHtml(profile.name)}</h2><div class="profile-list"><div class="profile-row"><input class="text-input profile-name" data-profile="${profile.id}" value="${escapeHtml(profile.name)}" aria-label="Имя профиля" /></div></div><p class="muted small">Профиль Яны добавим отдельно вместе с её собственными заданиями и баллами.</p></section>`;
}

function parentMonthMarkup(profile, monthKey) {
  const month = monthStats(state.entries, profile.id, monthKey);
  const monthWeeks = monthlyGoalWeeks(profile.id, monthKey);
  const bonus = bonusRecord(profile.id, monthKey);
  const bonusAmount = bonus?.amount || 0;
  const bestTotal = Math.max(0, ...monthWeeks.totals.map((item) => item.total));
  return `<section class="parent-month-section"><article class="card month-summary-card"><div class="card-heading"><div><p class="eyebrow">${escapeHtml(profile.name)}</p><h2>Итоги месяца</h2></div><span class="goal-badge">${month.net} / ${MONTH_GOAL} баллов</span></div><div class="month-metrics"><div><span>За баллы</span><strong>${formatMoney(month.money)}</strong></div><div><span>Премия</span><strong>${bonus ? `+${formatMoney(bonusAmount)}` : "—"}</strong></div><div class="total"><span>Всего к выплате</span><strong>${formatMoney(month.money + bonusAmount)}</strong></div><div><span>Недель по 55+</span><strong>${monthWeeks.qualified}</strong></div><div><span>Лучшая неделя</span><strong>${bestTotal} баллов</strong></div></div><div class="month-bonus-action"><div><strong>${bonus ? "Премия за месяц начислена" : "Премия за месяц"}</strong><span>${bonus ? `Начислено ${new Intl.DateTimeFormat("ru-RU").format(new Date(bonus.awardedAt))}` : "Решение принимает родитель"}</span></div>${bonus ? `<button class="button secondary" type="button" data-remove-bonus="${monthKey}" data-profile="${profile.id}">Отменить премию ${formatMoney(bonusAmount)}</button>` : `<button class="button" type="button" data-add-bonus="${monthKey}" data-profile="${profile.id}">Начислить ${formatMoney(MONTH_BONUS)}</button>`}</div></article><div class="month-calendar-note">В итог месяца входят только даты выбранного месяца. Итог каждой недели считается за все семь дней.</div><div class="month-weeks">${monthWeeks.totals.map((item) => parentMonthWeekMarkup(profile, monthKey, item.weekStart, item.total, bestTotal)).join("")}</div></section>`;
}

function parentMonthWeekMarkup(profile, monthKey, weekStart, total, bestTotal) {
  const dates = weekDates(weekStart);
  const stats = weekStats(state.entries, profile.id, weekStart);
  const isBest = bestTotal > 0 && total === bestTotal;
  return `<article class="card month-week-card"><div class="month-week-heading"><div><p class="eyebrow">Неделя</p><h3>${formatWeek(weekStart)}</h3></div><div class="week-statuses"><span class="week-result ${total >= GOAL ? "success" : ""}">${weekResultLabel(total)}</span>${isBest ? `<span class="best-week">Лучшая за месяц</span>` : ""}</div></div><div class="month-week-grid">${dates.map((date, index) => `<div class="month-day-cell ${date.slice(0, 7) !== monthKey ? "outside-month" : ""} ${stats.daily[index] >= Math.ceil(DAILY_AVERAGE) ? "on-target" : (stats.daily[index] !== 0 ? "filled" : "")}"><button class="month-day-main" type="button" data-edit-date="${date}" data-profile="${profile.id}" aria-label="Открыть ${DAYS[index].name}, ${formatDateShort(date)}"><span>${DAYS[index].short}, ${formatDateShort(date)}</span><strong>${stats.daily[index]}</strong><small>баллов</small></button><button class="month-sign ${isSigned(profile.id, date) ? "signed" : ""}" type="button" data-sign-date="${date}" data-profile="${profile.id}" ${signButtonDisabled(profile.id, date) ? "disabled" : ""} aria-label="${isSigned(profile.id, date) ? "Снять подпись" : "Подписать день"}">${signButtonText(profile.id, date)}</button></div>`).join("")}<button class="week-total-cell" type="button" data-open-week="${weekStart}"><span>Итого</span><strong>${total}</strong><small>${weekResultLabel(total)}</small></button></div></article>`;
}

function parentWeekCardMarkup(profile, weekStart) {
  const stats = weekStats(state.entries, profile.id, weekStart);
  const dates = weekDates(weekStart);
  const progress = Math.min(100, Math.max(0, (stats.net / GOAL) * 100));
  return `<article class="card child-summary"><div class="card-heading"><h2>${escapeHtml(profile.name)}</h2><span class="goal-badge">${weekResultLabel(stats.net)}</span></div><div class="summary-score">${stats.net}<span class="small muted"> / ${GOAL}</span></div><div class="summary-progress"><span style="width:${progress}%"></span></div><div class="mini-metrics"><div class="mini-metric"><strong>${stats.positive}</strong><span>положительные</span></div><div class="mini-metric"><strong>−${stats.penalties}</strong><span>штрафы</span></div><div class="mini-metric"><strong>${formatMoney(stats.money)}</strong><span>за неделю</span></div></div><div class="parent-days">${dates.map((date, index) => `<div class="parent-day"><div><strong>${DAYS[index].short}, ${formatDateShort(date)}</strong><span>${stats.daily[index]} баллов</span></div><button class="button secondary edit-day" type="button" data-edit-date="${date}" data-profile="${profile.id}">Изменить</button><button class="sign-button ${isSigned(profile.id, date) ? "signed" : ""}" type="button" data-sign-date="${date}" data-profile="${profile.id}" ${signButtonDisabled(profile.id, date) ? "disabled" : ""}>${signButtonText(profile.id, date, true)}</button></div>`).join("")}</div></article>`;
}

function render() {
  if (!state.profiles.length) return;
  normalizeUiPeriod();
  renderRoleSwitch();
  const childVisible = state.ui.role === "child" || state.ui.role === "parentEdit";
  document.querySelector("#childView").classList.toggle("hidden", !childVisible);
  document.querySelector("#parentView").classList.toggle("hidden", childVisible);
  renderChild();
  if (authContext?.role === "parent") renderParent();
}

function changeWeek(offset) {
  const nextWeek = toIsoDate(addDays(fromIsoDate(state.ui.selectedWeekStart), offset * 7));
  state.ui.selectedWeekStart = nextWeek < TRACKER_START_DATE ? TRACKER_START_DATE : nextWeek;
  const dates = weekDates(state.ui.selectedWeekStart);
  state.ui.selectedDate = dates.includes(todayIso) ? todayIso : dates[0];
  render();
}

function changeMonth(offset) {
  const current = fromIsoDate(`${state.ui.selectedMonth || todayIso.slice(0, 7)}-01`);
  const next = new Date(current.getFullYear(), current.getMonth() + offset, 1, 12);
  const nextMonth = toIsoDate(next).slice(0, 7);
  state.ui.selectedMonth = nextMonth < firstMonth ? firstMonth : nextMonth;
  render();
}

function showToast(message) {
  const toast = document.querySelector("#toast"); toast.textContent = message; toast.classList.add("show"); window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function scoreInputIsActive() {
  return document.activeElement?.classList.contains("score-input");
}

function applyLocalScore(profileId, dateIso, taskId, value) {
  state.entries[profileId] ||= {};
  state.entries[profileId][dateIso] ||= {};
  if (value === 0) {
    delete state.entries[profileId][dateIso][taskId];
    if (!Object.keys(state.entries[profileId][dateIso]).length) delete state.entries[profileId][dateIso];
  } else {
    state.entries[profileId][dateIso][taskId] = value;
  }
}

async function requestServerRefresh(fromRealtime = false) {
  if (scoreSaveCount > 0 || scoreInputIsActive()) {
    deferredServerRefresh = true;
    return;
  }
  deferredServerRefresh = false;
  await refreshFromServer(fromRealtime);
}

async function commitScoreInput(input) {
  if (input.dataset.saving === "true") return;
  const task = TASKS.find((item) => item.id === input.dataset.task);
  const dateIso = input.dataset.date;
  const profileId = input.dataset.profile;
  const result = validatePoints(task, input.value);
  const error = document.querySelector(`[data-error="${task.id}-${dateIso}"]`);
  if (!result.valid) {
    if (error) error.textContent = result.message;
    if (input.isConnected) window.setTimeout(() => input.focus(), 0);
    return;
  }
  if (error) error.textContent = "";
  const savedValue = input.dataset.savedValue === "" ? 0 : Number(input.dataset.savedValue);
  if (savedValue === result.value) {
    if (deferredServerRefresh) await requestServerRefresh(true);
    return;
  }
  input.dataset.saving = "true";
  scoreSaveCount += 1;
  try {
    await backend.saveScore(profileId, dateIso, task.id, result.value);
    applyLocalScore(profileId, dateIso, task.id, result.value);
    input.dataset.savedValue = result.value === 0 ? "" : String(result.value);
    showToast("Баллы сохранены");
  } catch (saveError) {
    console.error(saveError);
    showToast(saveError.message || "Не удалось сохранить изменение");
    deferredServerRefresh = true;
  } finally {
    scoreSaveCount -= 1;
    delete input.dataset.saving;
    await requestServerRefresh();
  }
}

async function runAction(action, successMessage) {
  try {
    await action();
    await refreshFromServer();
    if (successMessage) showToast(successMessage);
  } catch (error) {
    console.error(error);
    showToast(error.message || "Не удалось сохранить изменение");
  }
}

document.addEventListener("click", async (event) => {
  const childProfileButton = event.target.closest("[data-child-profile]");
  if (childProfileButton) { state.ui.selectedProfileId = childProfileButton.dataset.childProfile; state.ui.role = "parentEdit"; render(); return; }
  const roleButton = event.target.closest("[data-role]");
  if (roleButton) {
    if (roleButton.dataset.role === "parent" && authContext?.role !== "parent") return;
    state.ui.role = roleButton.dataset.role;
    render();
    return;
  }
  const weekButton = event.target.closest("[data-week]");
  if (weekButton) { changeWeek(Number(weekButton.dataset.week)); return; }
  const monthButton = event.target.closest("[data-month]");
  if (monthButton) { changeMonth(Number(monthButton.dataset.month)); return; }
  const parentViewButton = event.target.closest("[data-parent-view]");
  if (parentViewButton) { state.ui.parentViewMode = parentViewButton.dataset.parentView; render(); return; }
  const openWeekButton = event.target.closest("[data-open-week]");
  if (openWeekButton) { state.ui.selectedWeekStart = openWeekButton.dataset.openWeek; state.ui.parentViewMode = "week"; render(); return; }
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) { state.ui.viewMode = viewButton.dataset.view; render(); return; }
  const dayButton = event.target.closest(".day-tab[data-date]");
  if (dayButton) { state.ui.selectedDate = dayButton.dataset.date; render(); return; }
  const editButton = event.target.closest("[data-edit-date]");
  if (editButton) { state.ui.selectedProfileId = editButton.dataset.profile; state.ui.selectedDate = editButton.dataset.editDate; state.ui.selectedWeekStart = toIsoDate(startOfWeek(fromIsoDate(editButton.dataset.editDate))); state.ui.role = "parentEdit"; state.ui.viewMode = "day"; render(); return; }
  if (event.target.closest("#backToParent")) { state.ui.role = "parent"; render(); return; }
  const signButton = event.target.closest("[data-sign-date]");
  if (signButton) { const { profile, signDate } = signButton.dataset; if (isSigned(profile, signDate)) { if (!window.confirm(`Снять подпись с дня ${formatDateShort(signDate)}?`)) return; await runAction(() => backend.unsignDay(profile, signDate), "Подпись снята"); } else { if (!canParentSignDate(signDate, todayIso)) { showToast("Подписывать можно только прошедшие дни"); return; } await runAction(() => backend.signDay(profile, signDate), "День подписан"); } return; }
  const addBonus = event.target.closest("[data-add-bonus]");
  if (addBonus) { await runAction(() => backend.addBonus(addBonus.dataset.profile, addBonus.dataset.addBonus, MONTH_BONUS), "Премия начислена"); return; }
  const removeBonus = event.target.closest("[data-remove-bonus]");
  if (removeBonus) { if (!window.confirm("Отменить начисленную премию за этот месяц?")) return; await runAction(() => backend.removeBonus(removeBonus.dataset.profile, removeBonus.dataset.removeBonus), "Премия отменена"); return; }
  if (event.target.closest("#openSettings")) { document.querySelector("#settingsDialog").showModal(); return; }
});

document.addEventListener("change", async (event) => {
  if (event.target.id === "profileSelect") { state.ui.selectedProfileId = event.target.value; render(); return; }
  if (event.target.id === "parentProfileSelect") { state.ui.selectedProfileId = event.target.value; render(); return; }
  if (event.target.classList.contains("profile-name")) { const nextName = event.target.value.trim(); if (nextName) await runAction(() => backend.renameProfile(event.target.dataset.profile, nextName), "Имя сохранено"); }
});

document.addEventListener("input", (event) => {
  if (!event.target.classList.contains("score-input")) return;
  const error = document.querySelector(`[data-error="${event.target.dataset.task}-${event.target.dataset.date}"]`);
  if (error) error.textContent = "";
});

function selectScoreInputValue(input) {
  input.select();
}

document.addEventListener("focusin", (event) => {
  if (!event.target.classList.contains("score-input")) return;
  const input = event.target;
  input.dataset.replaceOnNextInput = "true";
  window.setTimeout(() => {
    if (document.activeElement === input) selectScoreInputValue(input);
  }, 0);
});

document.addEventListener("click", (event) => {
  if (!event.target.classList.contains("score-input")) return;
  const input = event.target;
  input.dataset.replaceOnNextInput = "true";
  window.setTimeout(() => {
    if (document.activeElement === input) selectScoreInputValue(input);
  }, 0);
});

document.addEventListener("beforeinput", (event) => {
  if (!event.target.classList.contains("score-input")) return;
  const input = event.target;
  if (input.dataset.replaceOnNextInput !== "true") return;
  if (event.inputType.startsWith("delete")) {
    event.preventDefault();
    input.value = "";
    input.dataset.replaceOnNextInput = "false";
    input.setSelectionRange(0, 0);
    return;
  }
  if (!event.inputType.startsWith("insert")) return;
  const inserted = event.data ?? event.dataTransfer?.getData("text/plain");
  if (inserted === null || inserted === undefined) return;
  event.preventDefault();
  input.value = inserted;
  input.dataset.replaceOnNextInput = "false";
  input.setSelectionRange(input.value.length, input.value.length);
  const error = document.querySelector(`[data-error="${input.dataset.task}-${input.dataset.date}"]`);
  if (error) error.textContent = "";
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.target.classList.contains("score-input")) return;
  event.preventDefault();
  event.target.blur();
});

document.addEventListener("focusout", (event) => {
  if (!event.target.classList.contains("score-input")) return;
  const input = event.target;
  window.setTimeout(() => commitScoreInput(input), 0);
});

document.querySelector("#exportData").addEventListener("click", () => {
  const backup = { version: 3, profiles: state.profiles, entries: state.entries, signoffs: state.signoffs, bonuses: state.bonuses };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `семейный-трекер-${todayIso}.json`; anchor.click(); URL.revokeObjectURL(url); showToast("Резервная копия сохранена");
});

document.querySelector("#importData").addEventListener("change", async (event) => {
  const [file] = event.target.files; if (!file) return;
  try { const parsed = JSON.parse(await file.text()); if (!window.confirm("Заменить данные выбранного ребёнка содержимым резервной копии?")) return; const sourceId = parsed.profiles?.[0]?.id || Object.keys(parsed.entries || {})[0]; const payload = { entries: parsed.entries?.[sourceId] || {}, signoffs: parsed.signoffs?.[sourceId] || {}, bonuses: parsed.bonuses?.[sourceId] || {} }; await runAction(() => backend.importBackup(selectedProfile().id, payload), "Данные восстановлены"); }
  catch (error) { console.error(error); showToast(error.message || "Не удалось прочитать файл"); }
  finally { event.target.value = ""; }
});

document.querySelector("#ambiguitiesList").innerHTML = SOURCE_AMBIGUITIES.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

function showAuth(message = "") {
  authUser = null;
  authContext = null;
  realtimeStarted = false;
  state = defaultState();
  document.querySelector("#authView").classList.remove("hidden");
  document.querySelector("#appMain").classList.add("hidden");
  document.querySelector("#roleSwitch").classList.add("hidden");
  document.querySelector("#accountActions").classList.add("hidden");
  document.querySelector("#authError").textContent = message;
}

function showApplication() {
  const isParent = authContext?.role === "parent";
  if (!isParent) state.ui.role = "child";
  else if (state.ui.role === "child") state.ui.role = "parent";
  document.querySelector("#authView").classList.add("hidden");
  document.querySelector("#appMain").classList.remove("hidden");
  document.querySelector("#accountActions").classList.remove("hidden");
  document.querySelector("#accountLabel").textContent = `${isParent ? "Родитель" : selectedProfile()?.name || "Ребёнок"} · ${authContext?.login || ""}`;
  document.querySelector("#sessionInfo").textContent = `${isParent ? "Родитель" : "Профиль ребёнка"}: ${authContext?.login || ""}. Данные синхронизируются через Supabase.`;
  document.querySelector("#exportData").disabled = !isParent;
  document.querySelector("#importData").disabled = !isParent;
  render();
}

async function refreshFromServer(fromRealtime = false) {
  if (!backend || !authUser || refreshing) return;
  refreshing = true;
  try {
    const loaded = await backend.loadFamilyState(authUser, state.ui);
    authContext = loaded.context;
    state = loaded.state;
    showApplication();
    if (!realtimeStarted) {
      backend.subscribe(() => requestServerRefresh(true));
      realtimeStarted = true;
    }
  } catch (error) {
    console.error(error);
    if (fromRealtime) showToast("Не удалось обновить данные");
    else showAuth(error.message || "Не удалось загрузить семейные данные");
  } finally {
    refreshing = false;
  }
}

document.querySelector("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#authError");
  const button = document.querySelector("#authSubmit");
  error.textContent = "";
  button.disabled = true;
  try {
    const result = await backend.signIn(document.querySelector("#authLogin").value, document.querySelector("#authPassword").value);
    authUser = result.user;
    await refreshFromServer();
  } catch (loginError) {
    console.error(loginError);
    error.textContent = "Неверный логин или пароль.";
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  document.querySelector("#settingsDialog").close();
  try { await backend.signOut(); }
  catch (error) { showToast(error.message || "Не удалось выйти"); }
});

async function initialize() {
  const notice = document.querySelector("#authSetupNotice");
  if (!globalThis.TRACKER_SUPABASE?.hasConfig(globalThis.SUPABASE_CONFIG)) {
    notice.textContent = "Supabase ещё не настроен. Заполните адрес проекта, публичный ключ и технические email для логинов в supabase-config.js.";
    notice.classList.remove("hidden");
    document.querySelector("#authSubmit").disabled = true;
    showAuth();
    return;
  }
  try {
    backend = globalThis.TRACKER_SUPABASE.createConfiguredStore();
    authSubscription = backend.onAuthStateChange((_event, session) => {
      if (!session?.user) { showAuth(); return; }
      authUser = session.user;
      window.setTimeout(() => refreshFromServer(), 0);
    });
    const session = await backend.getSession();
    if (session?.user) { authUser = session.user; await refreshFromServer(); }
    else showAuth();
  } catch (error) {
    console.error(error);
    showAuth(error.message || "Не удалось подключиться к Supabase");
  }
}

initialize();
