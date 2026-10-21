(function attachTrackerSupabase(global) {
  const trackerStartDate = global.TRACKER_DATA?.TRACKER_START_DATE || "2026-10-19";

  function hasConfig(config = global.SUPABASE_CONFIG) {
    return Boolean(
      config
      && /^https:\/\/[a-z0-9.-]+$/i.test(String(config.url || "").replace(/\/$/, ""))
      && String(config.publishableKey || "").trim().length > 20
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(config.authLogins?.mama || "").trim())
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(config.authLogins?.artemiy || "").trim())
    );
  }

  function normalizeLogin(login) {
    return String(login || "").trim().toLowerCase();
  }

  function resolveLoginEmail(login, authLogins = {}) {
    const email = String(authLogins[normalizeLogin(login)] || "").trim().toLowerCase();
    if (!email) throw new Error("Неверный логин или пароль.");
    return email;
  }

  function loginForEmail(email, authLogins = {}) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    return Object.entries(authLogins).find(([, value]) => String(value || "").trim().toLowerCase() === normalizedEmail)?.[0] || "";
  }

  function throwIfError(result, fallback) {
    if (result?.error) throw new Error(result.error.message || fallback);
    return result?.data;
  }

  function emptyServerState() {
    return { profiles: [], entries: {}, signoffs: {}, bonuses: {} };
  }

  function mapRowsToState(profiles = [], scoreRows = [], signoffRows = [], bonusRows = []) {
    const result = emptyServerState();
    result.profiles = profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      color: profile.color || "#1264b0",
      authUserId: profile.auth_user_id || null,
    }));

    for (const row of scoreRows) {
      result.entries[row.child_id] ||= {};
      result.entries[row.child_id][row.entry_date] ||= {};
      result.entries[row.child_id][row.entry_date][row.task_key] = Number(row.points);
    }

    for (const row of signoffRows) {
      result.signoffs[row.child_id] ||= {};
      result.signoffs[row.child_id][row.entry_date] = {
        signedAt: row.signed_at,
        signedBy: row.signed_by,
      };
    }

    for (const row of bonusRows) {
      result.bonuses[row.child_id] ||= {};
      result.bonuses[row.child_id][String(row.month_start).slice(0, 7)] = {
        amount: Number(row.amount),
        awardedAt: row.awarded_at,
        awardedBy: row.awarded_by,
      };
    }

    return result;
  }

  function createStore(client, authLogins = {}) {
    let context = null;
    let channel = null;
    let refreshTimer = null;

    async function getSession() {
      const data = throwIfError(await client.auth.getSession(), "Не удалось проверить сессию");
      return data?.session || null;
    }

    async function signIn(login, password) {
      const email = resolveLoginEmail(login, authLogins);
      const result = await client.auth.signInWithPassword({ email, password });
      if (result?.error) throw new Error("Неверный логин или пароль.");
      return result?.data;
    }

    async function signOut() {
      throwIfError(await client.auth.signOut(), "Не удалось выйти");
    }

    function onAuthStateChange(callback) {
      return client.auth.onAuthStateChange(callback);
    }

    async function loadFamilyState(user, uiState = {}) {
      const membership = throwIfError(
        await client.from("family_members").select("family_id, role").eq("user_id", user.id).maybeSingle(),
        "Не удалось определить роль пользователя"
      );
      if (!membership) throw new Error("Учётная запись не привязана к семье. Выполните шаг настройки пользователей из SUPABASE_SETUP.md.");

      const profiles = throwIfError(
        await client.from("child_profiles").select("id, family_id, auth_user_id, name, color").eq("family_id", membership.family_id).order("created_at"),
        "Не удалось загрузить профили"
      ) || [];
      if (!profiles.length) throw new Error("Для этой семьи не создан профиль ребёнка.");

      const childIds = profiles.map((profile) => profile.id);
      const [scoreResult, signoffResult, bonusResult] = await Promise.all([
        client.from("score_entries").select("child_id, entry_date, task_key, points, updated_at, updated_by").in("child_id", childIds).gte("entry_date", trackerStartDate),
        client.from("day_signoffs").select("child_id, entry_date, signed_at, signed_by").in("child_id", childIds).gte("entry_date", trackerStartDate),
        client.from("monthly_bonuses").select("child_id, month_start, amount, awarded_at, awarded_by").in("child_id", childIds),
      ]);

      const serverState = mapRowsToState(
        profiles,
        throwIfError(scoreResult, "Не удалось загрузить баллы") || [],
        throwIfError(signoffResult, "Не удалось загрузить подписи") || [],
        throwIfError(bonusResult, "Не удалось загрузить премии") || []
      );

      context = {
        familyId: membership.family_id,
        role: membership.role,
        userId: user.id,
        login: loginForEmail(user.email, authLogins),
      };

      return {
        context,
        state: {
          version: 3,
          ...serverState,
          ui: {
            ...uiState,
            selectedProfileId: profiles.some((profile) => profile.id === uiState.selectedProfileId)
              ? uiState.selectedProfileId
              : profiles[0].id,
          },
        },
      };
    }

    async function saveScore(childId, entryDate, taskKey, points) {
      if (Number(points) === 0) {
        throwIfError(
          await client.from("score_entries").delete().eq("child_id", childId).eq("entry_date", entryDate).eq("task_key", taskKey),
          "Не удалось удалить баллы"
        );
        return;
      }
      throwIfError(
        await client.from("score_entries").upsert({ child_id: childId, entry_date: entryDate, task_key: taskKey, points: Number(points) }, { onConflict: "child_id,entry_date,task_key" }),
        "Не удалось сохранить баллы"
      );
    }

    async function signDay(childId, entryDate) {
      throwIfError(await client.from("day_signoffs").insert({ child_id: childId, entry_date: entryDate }), "Не удалось подписать день");
    }

    async function unsignDay(childId, entryDate) {
      throwIfError(await client.from("day_signoffs").delete().eq("child_id", childId).eq("entry_date", entryDate), "Не удалось снять подпись");
    }

    async function addBonus(childId, monthKey, amount) {
      throwIfError(
        await client.from("monthly_bonuses").insert({ child_id: childId, month_start: `${monthKey}-01`, amount }),
        "Не удалось начислить премию"
      );
    }

    async function removeBonus(childId, monthKey) {
      throwIfError(await client.from("monthly_bonuses").delete().eq("child_id", childId).eq("month_start", `${monthKey}-01`), "Не удалось отменить премию");
    }

    async function renameProfile(childId, name) {
      throwIfError(await client.rpc("rename_child_profile", { p_child_id: childId, p_name: name }), "Не удалось изменить имя");
    }

    async function importBackup(childId, payload) {
      throwIfError(await client.rpc("import_tracker_backup", { p_child_id: childId, p_payload: payload }), "Не удалось импортировать резервную копию");
    }

    function subscribe(onChange) {
      if (!context) throw new Error("Сначала загрузите семейный профиль");
      if (channel) client.removeChannel(channel);
      const scheduleRefresh = () => {
        global.clearTimeout(refreshTimer);
        refreshTimer = global.setTimeout(onChange, 180);
      };
      channel = client.channel(`family-tracker-${context.familyId}`);
      for (const table of ["child_profiles", "score_entries", "day_signoffs", "monthly_bonuses"]) {
        channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleRefresh);
      }
      channel.subscribe();
      return channel;
    }

    async function close() {
      global.clearTimeout(refreshTimer);
      if (channel) await client.removeChannel(channel);
      channel = null;
      context = null;
    }

    return {
      getSession,
      signIn,
      signOut,
      onAuthStateChange,
      loadFamilyState,
      saveScore,
      signDay,
      unsignDay,
      addBonus,
      removeBonus,
      renameProfile,
      importBackup,
      subscribe,
      close,
    };
  }

  function createConfiguredStore(config = global.SUPABASE_CONFIG) {
    if (!hasConfig(config)) throw new Error("Заполните SUPABASE_CONFIG в файле supabase-config.js");
    if (!global.supabase?.createClient) throw new Error("Не удалось загрузить библиотеку Supabase");
    const client = global.supabase.createClient(config.url.replace(/\/$/, ""), config.publishableKey.trim(), {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    return createStore(client, config.authLogins);
  }

  global.TRACKER_SUPABASE = { hasConfig, normalizeLogin, resolveLoginEmail, loginForEmail, mapRowsToState, createStore, createConfiguredStore };
})(globalThis);
