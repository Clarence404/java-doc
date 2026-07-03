# Java 专项-synchronized

> 参考资料：
> * JEP 374 — Disable and Deprecate Biased Locking：[https://openjdk.org/jeps/374](https://openjdk.org/jeps/374)
> * HotSpot Runtime Overview：[https://openjdk.org/groups/hotspot/docs/RuntimeOverview.html](https://openjdk.org/groups/hotspot/docs/RuntimeOverview.html)

<div class="slk">

<!-- ① 路线对比 -->
<div class="slk-sec">
  <div class="slk-hd"><span class="slk-n">路线</span><span class="slk-t">旧 vs 现代</span></div>
  <div class="slk-card">
    <div class="slk-row-gap">
      <div>
        <div class="slk-sublabel">旧路线 <span class="slk-tag slk-tm">JDK 8~14</span></div>
        <div class="slk-flow">
          <span class="slk-lp slk-ul">无锁</span><span class="slk-arr">→</span>
          <span class="slk-lp slk-bi">偏向锁</span><span class="slk-arr">→</span>
          <span class="slk-lp slk-lw">轻量级锁</span><span class="slk-arr">→</span>
          <span class="slk-lp slk-hw">重量级锁</span>
        </div>
      </div>
      <div class="slk-divider"></div>
      <div>
        <div class="slk-sublabel">现代路线 <span class="slk-tag slk-tr">JDK 15+</span> 偏向锁已废弃/移除</div>
        <div class="slk-flow">
          <span class="slk-lp slk-ul">无锁</span><span class="slk-arr">→</span>
          <span class="slk-lp slk-lw">轻量级锁</span><span class="slk-arr">→</span>
          <span class="slk-lp slk-hw">重量级锁 / Monitor 锁</span>
        </div>
      </div>
    </div>
    <div class="slk-note-danger">偏向锁在 JDK 15 默认关闭并废弃，JDK 18 起相关选项 obsolete / 移除。<strong>讲锁升级必须先说 JDK 版本。</strong></div>
  </div>
</div>

<!-- ② 版本 -->
<div class="slk-sec">
  <div class="slk-hd"><span class="slk-n">01</span><span class="slk-t">锁升级先看版本</span></div>
  <div class="slk-card">
    <div class="slk-vtl">
      <div class="slk-vc">
        <div class="slk-ver">JDK 8 ~ 14</div>
        <div class="slk-vc-body">四阶段路径：<br>无锁 → 偏向锁<br>→ 轻量级锁<br>→ 重量级锁<br><span class="slk-muted" style="font-size:11px;">偏向锁默认开启</span></div>
      </div>
      <div class="slk-vc">
        <div class="slk-ver">JDK 15 ~ 17</div>
        <div class="slk-vc-body">偏向锁<strong style="color:#f85149;">默认关闭</strong>并废弃<br><code class="slk-code">-XX:+UseBiasedLocking</code><br><span class="slk-muted" style="font-size:11px;">仍可手动开启</span></div>
      </div>
      <div class="slk-vc">
        <div class="slk-ver">JDK 18+</div>
        <div class="slk-vc-body">偏向锁相关选项<br><strong style="color:#f85149;">obsolete</strong><br>实际路径：<br>无锁 → 轻量级锁<br>→ Monitor 锁</div>
      </div>
      <div class="slk-vc">
        <div class="slk-ver">JDK 23+</div>
        <div class="slk-vc-body">偏向锁完全<strong style="color:#f85149;">移除</strong><br>三阶段已成唯一路径<br><span class="slk-muted" style="font-size:11px;">偏向锁是历史概念</span></div>
      </div>
    </div>
    <div class="slk-two" style="margin-top:14px;">
      <div class="slk-card2" style="border-color:#6a7384;">
        <div class="slk-card2-title" style="color:#6a7384;">传统面试说法</div>
        <div style="font-size:12px;line-height:1.55;">无锁 → 偏向锁 → 轻量级锁 → 重量级锁<br><span class="slk-muted">适合限定 JDK 8~14</span></div>
      </div>
      <div class="slk-card2" style="border-color:#3fb950;">
        <div class="slk-card2-title" style="color:#3fb950;">现代准确说法</div>
        <div style="font-size:12px;line-height:1.55;">无锁 → 轻量级锁 → Monitor 锁<br><span class="slk-muted">偏向锁不是现代默认重点</span></div>
      </div>
    </div>
  </div>
</div>

<!-- ③ monitor -->
<div class="slk-sec">
  <div class="slk-hd"><span class="slk-n">02</span><span class="slk-t">synchronized 锁的是 monitor</span></div>
  <div class="slk-card">
    <div style="font-size:13px;margin-bottom:14px;">锁竞争的对象，是 obj 背后的 <strong style="color:#e85d04;">ObjectMonitor</strong>。Object Header 中 Mark Word 指向 monitor。</div>
    <div class="slk-mtype">
      <div class="slk-mt">
        <div class="slk-mt-n">① 同步代码块</div>
        <div class="slk-code2">synchronized(obj){...}</div>
        <div class="slk-muted" style="font-size:11px;">锁 obj 背后的 monitor</div>
      </div>
      <div class="slk-mt">
        <div class="slk-mt-n">② 实例方法</div>
        <div class="slk-code2">public synchronized void f()</div>
        <div class="slk-muted" style="font-size:11px;">锁 this 的 monitor</div>
      </div>
      <div class="slk-mt">
        <div class="slk-mt-n">③ 静态方法</div>
        <div class="slk-code2">public static synchronized void f()</div>
        <div class="slk-muted" style="font-size:11px;">锁 MyClass.class 的 monitor</div>
      </div>
    </div>
    <div class="slk-tags-row" style="margin-top:14px;">
      <div class="slk-pill"><span style="color:#d4a017;font-weight:700;">同一时刻</span>：最多一个线程持有该 monitor</div>
      <div class="slk-pill"><span style="color:#d4a017;font-weight:700;">happens-before</span>：释放 monitor → 后续获取同一 monitor</div>
      <div class="slk-pill"><span style="color:#d4a017;font-weight:700;">三重保证</span>：互斥性 + 可见性 + 有序性</div>
    </div>
    <div class="slk-note-ok">synchronized 的语义核心是<strong>获取对象 monitor</strong>，锁升级是 HotSpot 在获取 monitor 路径上的优化，不是 Java 语言规范的要求。</div>
  </div>
</div>

<!-- ④ 四状态 -->
<div class="slk-sec">
  <div class="slk-hd"><span class="slk-n">03</span><span class="slk-t">四锁状态详解 <span style="font-size:12px;font-weight:400;color:#6a7384;">JDK 8~14 视角</span></span></div>
  <div class="slk-card">
    <div class="slk-sg">
      <div class="slk-sc slk-sc-ul">
        <div class="slk-sc-name" style="color:#3fb950;">① 无锁</div>
        <div class="slk-sc-body">对象刚创建，通常无锁<br>Mark Word 存：hashcode、GC 年龄、锁标志等信息<br><br><span style="color:#3fb950;">触发：</span>对象创建后首次被访问</div>
      </div>
      <div class="slk-sc slk-sc-bi">
        <div class="slk-sc-name" style="color:#58a6ff;">② 偏向锁 <span class="slk-tag slk-tm" style="font-size:10px;">JDK 8~14</span></div>
        <div class="slk-sc-body">适合同一线程反复进入<br>Mark Word 记录偏向线程 T1 的 ID<br>成本极低，<strong>几乎不需要 CAS</strong><br><br><span style="color:#58a6ff;">触发：</span>T1 总是自己进入</div>
      </div>
      <div class="slk-sc slk-sc-lw">
        <div class="slk-sc-name" style="color:#d4a017;">③ 轻量级锁</div>
        <div class="slk-sc-body">适合轻微竞争场景<br>线程栈帧创建 <strong>Lock Record</strong><br><strong>CAS</strong> 尝试将对象头指向 Lock Record<br><br><span style="color:#d4a017;">触发：</span>T2 也来竞争，偏向撤销 / CAS 失败</div>
      </div>
      <div class="slk-sc slk-sc-hw">
        <div class="slk-sc-name" style="color:#e85d04;">④ 重量级锁 / Monitor 锁</div>
        <div class="slk-sc-body">竞争激烈，膨胀为 <strong>ObjectMonitor</strong><br>Owner / EntryList(cxq) / WaitSet<br>竞争失败线程阻塞，OS 调度唤醒<br><br><span style="color:#e85d04;">触发：</span>CAS 自旋失败 / 调用 wait()</div>
      </div>
    </div>
    <div style="margin-top:18px;">
      <div class="slk-sublabel" style="margin-bottom:10px;">升级触发关系（从左到右）</div>
      <div class="slk-chain">
        <div class="slk-cn"><div class="slk-cn-t" style="color:#3fb950;">T1 总是自进</div><div class="slk-cn-b">偏向锁最合适<br>Mark Word 记 T1</div></div>
        <div class="slk-cn-arr">→</div>
        <div class="slk-cn"><div class="slk-cn-t" style="color:#58a6ff;">T2 也来竞争</div><div class="slk-cn-b">偏向撤销<br>可能转轻量级锁</div></div>
        <div class="slk-cn-arr">→</div>
        <div class="slk-cn"><div class="slk-cn-t" style="color:#d4a017;">CAS 失败</div><div class="slk-cn-b">可能短暂自旋<br>等待 T1 释放</div></div>
        <div class="slk-cn-arr">→</div>
        <div class="slk-cn"><div class="slk-cn-t" style="color:#e85d04;">竞争仍在</div><div class="slk-cn-b">膨胀为<br>Monitor 锁</div></div>
      </div>
    </div>
  </div>
</div>

<!-- ⑤ 轻量级锁 -->
<div class="slk-sec">
  <div class="slk-hd"><span class="slk-n">04</span><span class="slk-t">轻量级锁 — Lock Record + CAS</span></div>
  <div class="slk-card">
    <div class="slk-two">
      <div>
        <div class="slk-sublabel" style="color:#d4a017;margin-bottom:10px;">T1 首次获取轻量级锁（5 步）</div>
        <div class="slk-steps">
          <div class="slk-stp"><span class="slk-stn">1</span><span>T1 进入 <code class="slk-code">synchronized(obj)</code></span></div>
          <div class="slk-stp"><span class="slk-stn">2</span><span>T1 <strong>栈帧</strong>中创建 Lock Record（含 Displaced Mark Word 槽位）</span></div>
          <div class="slk-stp"><span class="slk-stn">3</span><span>把 obj 的 Mark Word <strong>拷贝</strong>到 Lock Record</span></div>
          <div class="slk-stp"><span class="slk-stn">4</span><span><strong>CAS</strong> 尝试将 obj 的 Mark Word 改为指向 Lock Record 的指针</span></div>
          <div class="slk-stp"><span class="slk-stn">5</span><span>CAS 成功：获得轻量级锁，obj Mark Word 指向 Lock Record ✓</span></div>
        </div>
      </div>
      <div>
        <div class="slk-sublabel" style="margin-bottom:10px;">T2 竞争 — 自旋等待策略</div>
        <div class="slk-steps">
          <div class="slk-stp"><span class="slk-stn">1</span><span>T1 持有轻量级锁</span></div>
          <div class="slk-stp"><span class="slk-stn">2</span><span>T2 进入 synchronized(obj)</span></div>
          <div class="slk-stp"><span class="slk-stn">3</span><span>T2 <strong>CAS 失败</strong></span></div>
          <div class="slk-stp"><span class="slk-stn">4</span><span>短暂 <strong>自旋</strong>（spin）</span></div>
          <div class="slk-stp"><span class="slk-stn">5a</span><span>T1 快速释放 → T2 获锁，避免阻塞/唤醒开销</span></div>
          <div class="slk-stp"><span class="slk-stn">5b</span><span>竞争持续 → 膨胀为 Monitor 锁</span></div>
        </div>
      </div>
    </div>
    <div class="slk-sg" style="margin-top:14px;">
      <div class="slk-sc" style="border-color:#3fb950;"><div class="slk-sc-name" style="color:#3fb950;">自旋收益</div><div class="slk-sc-body">避免 OS 线程阻塞、唤醒、上下文切换的开销<br>适合竞争短暂的场景</div></div>
      <div class="slk-sc" style="border-color:#f85149;"><div class="slk-sc-name" style="color:#f85149;">自旋代价</div><div class="slk-sc-body">占用 CPU 空转<br>竞争时间长则浪费</div></div>
      <div class="slk-sc" style="border-color:#d4a017;"><div class="slk-sc-name" style="color:#d4a017;">何时划算</div><div class="slk-sc-body">竞争短：划算<br>竞争长：不如直接阻塞<br>JVM 自适应调整自旋次数</div></div>
      <div class="slk-sc" style="border-color:#58a6ff;"><div class="slk-sc-name" style="color:#58a6ff;">常见误解</div><div class="slk-sc-body">自旋<strong>不是</strong>一种锁状态<br>不在 Mark Word 里独立表示<br>只是竞争失败后的等待策略</div></div>
    </div>
    <div class="slk-note-ok">轻量级锁核心：Lock Record 记录原 Mark Word 的备份（Displaced Mark Word），CAS 成功让 Mark Word 指向 Lock Record。</div>
  </div>
</div>

<!-- ⑥ ObjectMonitor -->
<div class="slk-sec">
  <div class="slk-hd"><span class="slk-n">05</span><span class="slk-t">ObjectMonitor — 慢路径</span></div>
  <div class="slk-card">
    <div class="slk-two">
      <div>
        <div class="slk-sublabel" style="color:#e85d04;margin-bottom:10px;">ObjectMonitor 结构</div>
        <div class="slk-om">
          <div class="slk-om-title">ObjectMonitor</div>
          <div class="slk-om-row"><div class="slk-om-f">Owner</div><div class="slk-muted" style="font-size:11px;margin-top:2px;">当前持有锁的线程</div></div>
          <div class="slk-om-row"><div class="slk-om-f">EntryList (cxq)</div><div class="slk-muted" style="font-size:11px;margin-top:2px;">等待进入锁的竞争线程队列</div></div>
          <div class="slk-om-row"><div class="slk-om-f">WaitSet</div><div class="slk-muted" style="font-size:11px;margin-top:2px;">调用 wait() 后等待 notify 的线程集合</div></div>
          <div class="slk-om-row"><div class="slk-om-f">Recursions</div><div class="slk-muted" style="font-size:11px;margin-top:2px;">可重入计数（同一线程重入次数）</div></div>
        </div>
      </div>
      <div>
        <div class="slk-sublabel" style="color:#58a6ff;margin-bottom:10px;">wait / notify 流程（6 步）</div>
        <div class="slk-steps">
          <div class="slk-stp"><span class="slk-stn" style="color:#58a6ff;">1</span><span>线程持有 monitor（Owner）</span></div>
          <div class="slk-stp"><span class="slk-stn" style="color:#58a6ff;">2</span><span>调用 <code class="slk-code">wait()</code></span></div>
          <div class="slk-stp"><span class="slk-stn" style="color:#58a6ff;">3</span><span>释放 monitor，Owner 清空</span></div>
          <div class="slk-stp"><span class="slk-stn" style="color:#58a6ff;">4</span><span>进入 <strong>WaitSet</strong> 等待通知</span></div>
          <div class="slk-stp"><span class="slk-stn" style="color:#58a6ff;">5</span><span>notify / notifyAll / 中断 / 超时 / 伪唤醒</span></div>
          <div class="slk-stp"><span class="slk-stn" style="color:#58a6ff;">6</span><span>重新竞争 monitor（移回 EntryList）</span></div>
        </div>
      </div>
    </div>
    <div style="margin-top:14px;">
      <div class="slk-sublabel" style="margin-bottom:8px;">锁膨胀触发条件</div>
      <div class="slk-triggers">
        <span class="slk-trig">竞争激烈</span>
        <span class="slk-trig">自旋失败</span>
        <span class="slk-trig">调用 wait()</span>
        <span class="slk-trig">notify / notifyAll 需要 WaitSet</span>
        <span class="slk-trig">JNI locking</span>
        <span class="slk-trig">轻量级路径不足</span>
      </div>
    </div>
    <div class="slk-note-ok">ObjectMonitor 空闲后 JVM 可能做 <strong>deflation（锁收缩）</strong> 回收 monitor 结构。"锁升级绝对不可逆"这一说法<strong>不严谨</strong>。</div>
  </div>
</div>

<!-- ⑦ 误区 -->
<div class="slk-sec">
  <div class="slk-hd"><span class="slk-n">06</span><span class="slk-t">5 个常见误区</span></div>
  <div class="slk-card">
    <div class="slk-mis"><div class="slk-mis-w"><div class="slk-mis-lbl">误区 1</div><div class="slk-mis-txt">锁升级是 <strong>Java 语言规范</strong>强制机制</div></div><div class="slk-mis-c"><div class="slk-mis-lbl slk-mis-lbl-ok">纠正</div><div class="slk-mis-txt">规范只定义 monitor 语义（lock / unlock / wait set / happens-before）；偏向锁、ObjectMonitor inflation 是 <strong>HotSpot 实现优化</strong></div></div></div>
    <div class="slk-mis"><div class="slk-mis-w"><div class="slk-mis-lbl">误区 2</div><div class="slk-mis-txt">偏向锁是<strong>现代 JDK 的默认重点</strong></div></div><div class="slk-mis-c"><div class="slk-mis-lbl slk-mis-lbl-ok">纠正</div><div class="slk-mis-txt">JDK 15 默认关闭并废弃，JDK 18 相关选项 obsolete，回答时必须<strong>说明版本</strong></div></div></div>
    <div class="slk-mis"><div class="slk-mis-w"><div class="slk-mis-lbl">误区 3</div><div class="slk-mis-txt"><strong>自旋是一种锁状态</strong>（和偏向锁、轻量级锁并列）</div></div><div class="slk-mis-c"><div class="slk-mis-lbl slk-mis-lbl-ok">纠正</div><div class="slk-mis-txt">自旋是竞争失败后的<strong>等待策略</strong>，不是对象头 Mark Word 里的独立锁状态</div></div></div>
    <div class="slk-mis"><div class="slk-mis-w"><div class="slk-mis-lbl">误区 4</div><div class="slk-mis-txt">重量级锁 = synchronized <strong>一定很慢</strong></div></div><div class="slk-mis-c"><div class="slk-mis-lbl slk-mis-lbl-ok">纠正</div><div class="slk-mis-txt">真正贵的是<strong>高竞争下的阻塞、唤醒、上下文切换</strong>和 monitor 管理，不是锁本身</div></div></div>
    <div class="slk-mis" style="margin-bottom:0;"><div class="slk-mis-w"><div class="slk-mis-lbl">误区 5</div><div class="slk-mis-txt">锁<strong>绝对不能降级</strong></div></div><div class="slk-mis-c"><div class="slk-mis-lbl slk-mis-lbl-ok">纠正</div><div class="slk-mis-txt">JVM 可在 monitor 空闲后做 <strong>deflation</strong> 回收，"绝对不可逆"说法不严谨</div></div></div>
  </div>
</div>

<!-- ⑧ 面试答法 -->
<div class="slk-sec">
  <div class="slk-hd"><span class="slk-n">07</span><span class="slk-t">面试标准答法（按版本区分）</span></div>
  <div class="slk-card">
    <div class="slk-ia"><span class="slk-ia-badge">JDK 8</span><span>讲四阶段路径：<span class="slk-tag slk-tg">无锁</span> → <span class="slk-tag slk-tb">偏向锁</span> → <span class="slk-tag slk-ty">轻量级锁</span> → <span class="slk-tag slk-tr">重量级锁</span>，并说明这是 HotSpot 优化，不是语言规范</span></div>
    <div class="slk-ia"><span class="slk-ia-badge">JDK 17+</span><span>说明偏向锁已默认关闭并废弃，现代默认路径是 <span class="slk-tag slk-tg">无锁</span> → <span class="slk-tag slk-ty">轻量级锁</span> → <span class="slk-tag slk-tr">Monitor 锁</span></span></div>
    <div class="slk-ia"><span class="slk-ia-badge">现代HotSpot</span><span>理解为：根据竞争程度，从<strong>快速用户态路径（Lock Record + CAS）</strong>切到完整 <strong>ObjectMonitor 路径</strong>的动态优化</span></div>
    <div class="slk-ia" style="margin-bottom:0;"><span class="slk-ia-badge">核心本质</span><span>锁升级不是 Java 语法语义，而是 HotSpot 根据竞争程度选择不同 monitor 实现路径的<strong>优化细节</strong></span></div>
  </div>
</div>

<!-- summary -->
<div class="slk-summary">
  <div class="slk-sum-lbl">一句话总结</div>
  <div class="slk-sum-txt">synchronized 锁升级是 HotSpot 根据竞争程度，从轻量路径逐步走向 ObjectMonitor 路径的优化细节。<br><span style="font-size:13px;color:#6a7384;display:block;margin-top:6px;">讲锁升级，先问：你说的是哪个 JDK？</span></div>
</div>

</div>

<style>
.slk{background:#0f1115;border-radius:12px;padding:28px 24px;margin:16px 0;color:#cdd5e0;font-size:14px;line-height:1.6;font-family:-apple-system,'PingFang SC','Microsoft YaHei',system-ui,sans-serif;}
.slk *{box-sizing:border-box;}
.slk-sec{margin-bottom:28px;}
.slk-hd{display:flex;align-items:center;gap:10px;margin-bottom:14px;}
.slk-n{font-size:9px;font-weight:800;letter-spacing:.14em;color:#e85d04;text-transform:uppercase;padding:3px 7px;border:1px solid rgba(232,93,4,.35);border-radius:3px;font-family:monospace;}
.slk-t{font-size:16px;font-weight:700;color:#fff;}
.slk-card{background:#181c23;border:1px solid #2a303d;border-radius:8px;padding:20px;}
.slk-sublabel{font-size:11px;color:#6a7384;font-weight:600;margin-bottom:6px;}
.slk-muted{color:#6a7384;}
.slk-divider{border-top:1px solid #2a303d;margin:14px 0;}
.slk-row-gap{display:flex;flex-direction:column;gap:0;}
.slk-flow{display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:8px 0;}
.slk-lp{padding:5px 14px;border-radius:20px;font-size:13px;font-weight:700;border:2px solid;white-space:nowrap;}
.slk-ul{background:rgba(63,185,80,.12);border-color:#3fb950;color:#3fb950;}
.slk-bi{background:rgba(88,166,255,.12);border-color:#58a6ff;color:#58a6ff;}
.slk-lw{background:rgba(212,160,23,.12);border-color:#d4a017;color:#d4a017;}
.slk-hw{background:rgba(232,93,4,.12);border-color:#e85d04;color:#e85d04;}
.slk-arr{color:#6a7384;font-size:16px;padding:0 2px;}
.slk-note-danger{background:rgba(248,81,73,.07);border-left:3px solid #f85149;padding:9px 12px;border-radius:0 4px 4px 0;font-size:12px;margin-top:12px;line-height:1.5;}
.slk-note-ok{background:rgba(63,185,80,.07);border-left:3px solid #3fb950;padding:9px 12px;border-radius:0 4px 4px 0;font-size:12px;margin-top:12px;line-height:1.5;}
.slk-vtl{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}
.slk-vc{background:#1e2330;border:1px solid #2a303d;border-radius:6px;padding:14px;}
.slk-ver{font-size:12px;font-weight:800;color:#e85d04;font-family:monospace;margin-bottom:8px;}
.slk-vc-body{font-size:12px;line-height:1.55;}
.slk-two{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.slk-card2{background:#1e2330;border-radius:6px;padding:12px;border-left:3px solid;}
.slk-card2-title{font-size:11px;font-weight:700;margin-bottom:6px;}
.slk-mtype{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
.slk-mt{background:#1e2330;border-radius:6px;padding:12px;border-top:2px solid #e85d04;}
.slk-mt-n{font-size:10px;font-weight:800;color:#e85d04;font-family:monospace;margin-bottom:6px;}
.slk-code2{font-size:10px;font-family:monospace;color:#58a6ff;background:#0f1115;padding:5px 8px;border-radius:4px;margin-bottom:6px;overflow-x:auto;white-space:nowrap;}
.slk-code{font-size:12px;font-family:monospace;color:#58a6ff;background:#1e2330;padding:1px 5px;border-radius:3px;}
.slk-tags-row{display:flex;flex-wrap:wrap;gap:8px;}
.slk-pill{background:#1e2330;border-radius:6px;padding:9px 14px;font-size:12px;flex:1;min-width:180px;}
.slk-sg{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.slk-sc{background:#1e2330;border-radius:6px;padding:14px;border-left:3px solid;}
.slk-sc-ul{border-color:#3fb950;}
.slk-sc-bi{border-color:#58a6ff;}
.slk-sc-lw{border-color:#d4a017;}
.slk-sc-hw{border-color:#e85d04;}
.slk-sc-name{font-size:13px;font-weight:700;margin-bottom:6px;}
.slk-sc-body{font-size:12px;color:#6a7384;line-height:1.6;}
.slk-chain{display:flex;align-items:flex-start;gap:0;overflow-x:auto;padding:4px 0 8px;}
.slk-cn{background:#1e2330;border:1px solid #2a303d;border-radius:6px;padding:10px 12px;min-width:120px;flex-shrink:0;}
.slk-cn-t{font-size:11px;font-weight:700;margin-bottom:4px;}
.slk-cn-b{font-size:11px;color:#6a7384;line-height:1.45;}
.slk-cn-arr{display:flex;align-items:center;padding:0 6px;color:#e85d04;font-size:18px;flex-shrink:0;margin-top:16px;}
.slk-steps{display:flex;flex-direction:column;gap:8px;}
.slk-stp{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.5;}
.slk-stn{min-width:22px;height:22px;background:#1e2330;border:1px solid #2a303d;border-radius:50%;font-size:11px;font-weight:700;color:#d4a017;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px;font-family:monospace;}
.slk-om{border:2px solid #e85d04;border-radius:8px;overflow:hidden;}
.slk-om-title{background:rgba(232,93,4,.18);padding:9px 14px;font-size:13px;font-weight:800;color:#e85d04;letter-spacing:.04em;}
.slk-om-row{padding:9px 14px;border-top:1px solid #2a303d;}
.slk-om-f{font-size:12px;font-family:monospace;color:#d4a017;font-weight:600;}
.slk-triggers{display:flex;flex-wrap:wrap;gap:6px;}
.slk-trig{background:#1e2330;border:1px solid #2a303d;border-radius:4px;padding:4px 10px;font-size:11px;color:#6a7384;}
.slk-mis{display:grid;grid-template-columns:1fr 1fr;gap:0;background:#1e2330;border-radius:6px;overflow:hidden;margin-bottom:8px;border:1px solid #2a303d;}
.slk-mis-w{padding:12px 14px;border-right:1px solid #2a303d;}
.slk-mis-c{padding:12px 14px;background:rgba(63,185,80,.04);}
.slk-mis-lbl{font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px;color:#f85149;}
.slk-mis-lbl-ok{color:#3fb950;}
.slk-mis-txt{font-size:12px;line-height:1.55;}
.slk-ia{display:flex;gap:10px;padding:12px;background:#1e2330;border-radius:6px;margin-bottom:8px;font-size:13px;line-height:1.6;align-items:flex-start;}
.slk-ia-badge{background:#181c23;border:1px solid #2a303d;border-radius:4px;padding:2px 8px;font-size:10px;font-weight:800;color:#e85d04;white-space:nowrap;font-family:monospace;flex-shrink:0;margin-top:1px;}
.slk-summary{background:rgba(232,93,4,.08);border:1px solid rgba(232,93,4,.3);border-radius:8px;padding:20px 24px;margin-top:4px;text-align:center;}
.slk-sum-lbl{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#e85d04;font-weight:800;margin-bottom:8px;font-family:monospace;}
.slk-sum-txt{font-size:15px;font-weight:600;line-height:1.6;}
.slk-tag{display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:700;font-family:monospace;}
.slk-tg{background:rgba(63,185,80,.14);color:#3fb950;}
.slk-tb{background:rgba(88,166,255,.14);color:#58a6ff;}
.slk-ty{background:rgba(212,160,23,.14);color:#d4a017;}
.slk-tr{background:rgba(232,93,4,.14);color:#e85d04;}
.slk-tm{background:rgba(106,115,132,.14);color:#6a7384;}
/* tablet ≤768px */
@media(max-width:768px){
  .slk{padding:22px 16px;}
  .slk-vtl{grid-template-columns:1fr 1fr;}
  .slk-mtype{grid-template-columns:1fr 1fr;}
}
/* mobile ≤520px */
@media(max-width:520px){
  .slk{padding:16px 12px;border-radius:8px;}
  .slk-card{padding:14px;}
  .slk-t{font-size:14px;}
  .slk-vtl{grid-template-columns:1fr 1fr;}
  .slk-mtype{grid-template-columns:1fr;}
  .slk-sg,.slk-two{grid-template-columns:1fr;}
  .slk-mis{grid-template-columns:1fr;}
  .slk-mis-w{border-right:none;border-bottom:1px solid #2a303d;}
  .slk-chain{flex-direction:column;align-items:stretch;}
  .slk-cn{min-width:unset;width:100%;}
  .slk-cn-arr{transform:rotate(90deg);align-self:center;margin:2px 0;padding:0;}
  .slk-pill{min-width:unset;width:100%;}
  .slk-ia{flex-wrap:wrap;}
}
/* small phone ≤380px */
@media(max-width:380px){
  .slk-vtl{grid-template-columns:1fr;}
  .slk-ia{flex-direction:column;gap:6px;}
  .slk-ia-badge{align-self:flex-start;}
}
</style>
