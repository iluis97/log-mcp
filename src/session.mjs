/**
 * 会话级「数据源锁」。
 *
 * 背景：配置里有多套标签（环境）时，模型很容易「每个都试一遍」，然后拿错机器的
 * 日志下结论。这里把这件事在 MCP 层硬性卡住，而不是只靠提示词：
 *
 *  - 没指定标签、又有多套标签 → 拒绝执行，并把会话置为 pending（必须先问用户）；
 *  - pending 期间任何日志工具都被拒绝（连「换个标签再试」也不行）；
 *  - 只有 log_confirm_env(env=…, evidence=…) 能解除 pending；
 *  - 确认后本次会话锁在这个标签上，想换必须再确认一次（同样要问用户）。
 *
 * 单标签配置不受影响（没有歧义，直接用）。
 */

export function createSessionGuard() {
  let confirmed = null; // 用户确认过的标签
  let used = null; // 本次会话实际查过的标签
  let pending = false; // 有歧义但还没问用户
  let refusals = 0; // 被拒次数（用于升级提示语气）
  let confirmedAt = null;
  let evidence = null;

  function refuse(kind, message) {
    refusals += 1;
    return { ok: false, kind, refusals, message: escalate(message, refusals) };
  }

  /** 被反复重试时，把话说得更直白。 */
  function escalate(message, count) {
    if (count < 2) return message;
    return `${message}\n\n（这已经是第 ${count} 次被拒绝：停止尝试其它标签，也不要换参数重试。现在就问用户：这次看哪个环境/哪台机器？）`;
  }

  return {
    get state() {
      return { confirmed, used, pending, refusals, confirmedAt, evidence };
    },

    /** 校验一次日志工具调用能不能放行。 */
    check(requested, envNames) {
      const names = envNames ?? [];
      if (names.length <= 1) return { ok: true, env: requested ?? names[0] ?? null };

      if (pending) {
        return refuse(
          'pending',
          `已拒绝：还没有确定日志数据源（候选: ${names.join(' | ')}）。\n先问用户这次看哪个环境/哪台机器，再调用 log_confirm_env(env="<标签>", evidence="用户怎么说") 确认；在那之前任何日志查询都会被拒绝，也不要换别的标签重试。`,
        );
      }

      if (!requested) {
        pending = true;
        return refuse(
          'ambiguous',
          `已拒绝：配置里有 ${names.length} 套环境标签（${names.join(' | ')}），必须先确定用哪个。\n不要再逐个标签去试——先问用户（或者先 log_sources() 拿到全景再问），然后调用 log_confirm_env(env="<标签>", evidence="用户怎么说")。`,
        );
      }

      if (!names.includes(requested)) {
        return refuse('unknown', `已拒绝：没有 ${requested} 这个标签（可用: ${names.join(' | ')}）。先问用户要哪个环境。`);
      }

      if (confirmed && requested !== confirmed) {
        return refuse(
          'switch',
          `已拒绝：本次会话已确认为 ${confirmed}，不能再查 ${requested}。\n如果用户确实要换环境，先问他，再调用 log_confirm_env(env="${requested}", evidence="用户怎么说")。`,
        );
      }

      if (!confirmed && used && requested !== used) {
        pending = true;
        return refuse(
          'switch-unconfirmed',
          `已拒绝：本次会话已经在查 ${used}，不能顺手再查 ${requested}（这正是"每个环境都试一遍"）。\n先问用户到底看哪个，再调用 log_confirm_env(env="<标签>", evidence="用户怎么说")。`,
        );
      }

      used = requested;
      refusals = 0;
      return { ok: true, env: requested };
    },

    /** 用户确认数据源。只有它能解除 pending / 切换标签。 */
    confirm(env, why) {
      confirmed = env;
      used = env;
      pending = false;
      refusals = 0;
      confirmedAt = new Date().toISOString();
      evidence = why ?? null;
      return this.state;
    },
  };
}
