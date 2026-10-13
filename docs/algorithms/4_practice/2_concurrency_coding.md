---
description: 交替打印、按序执行、赛跑、任一成功即返回、任务超时、LRU 缓存
---

# 多线程编程题

> 前置阅读：[线程基础](/java/23_topic_thread_basics)、[显式锁（Lock）](/java/25_topic_lock)、[同步工具类](/java/27_topic_juc_tools)

面试中的多线程手写题考的是能否把「共享状态 + 等待条件 + 唤醒」写对。本篇讲交替打印、按序执行、赛跑、任一成功、超时与 LRU 六类题，均为可运行的完整程序，基线为 JDK 21。

---

## 一、解题套路

几乎所有协作类题目都是同一个骨架：

- **共享状态**：用一个变量表示「现在轮到谁」或「进行到哪一步」，只在锁内读写，或声明为 `volatile` / 原子类
- **等待条件写在 `while` 里**：被唤醒不代表条件已满足（可能是虚假唤醒，也可能被别的线程抢先改了状态），醒来后必须重新判断
- **改完状态再唤醒**：先修改共享状态，再 `notifyAll` / `signal` / `release`；先判断状态再决定是否等待，就不会出现「通知早于等待而丢失」的问题
- **收尾**：最后一个线程退出前也要唤醒对方，否则对方可能永远等下去；中断时恢复中断标志后退出

`wait` / `notify`、`Condition`、`LockSupport` 的语义对比见 [线程基础](/java/23_topic_thread_basics#五、线程的等待与唤醒机制)。

| 工具 | 适合的题型 | 要点 |
|------|-----------|------|
| `synchronized` + `wait` / `notifyAll` | 两个线程轮流 | 只有一个等待队列，人多时要 `notifyAll` |
| `ReentrantLock` + `Condition` | 多个线程轮流 | 每个角色一个 `Condition`，精确唤醒下一个 |
| `Semaphore` | 交接「许可」 | 不需要共享计数器，最不容易写错 |
| `CountDownLatch` / `CyclicBarrier` | 等待一组线程 | 一次性 / 可循环 |
| `CompletableFuture` / `ExecutorService` | 编排结果、超时 | 优先用现成的组合方法 |

---

## 二、两个线程交替打印奇偶数

题目：两个线程交替打印 1 到 10，一个只打奇数，一个只打偶数。

### 1、synchronized + wait / notifyAll

```java
public class OddEvenSync {
    private static final int MAX = 10;
    private static final Object LOCK = new Object();
    private static int next = 1;                 // 下一个要打印的数，只在锁内读写

    public static void main(String[] args) throws InterruptedException {
        Thread odd = new Thread(() -> print(1), "odd");
        Thread even = new Thread(() -> print(0), "even");
        odd.start();
        even.start();
        odd.join();
        even.join();
    }

    private static void print(int remainder) {
        synchronized (LOCK) {
            while (next <= MAX) {
                if (next % 2 == remainder) {     // 轮到自己：打印并唤醒对方
                    System.out.println(Thread.currentThread().getName() + ": " + next++);
                    LOCK.notifyAll();
                } else {                         // 没轮到：释放锁等待，醒来后回到 while 重新判断
                    try {
                        LOCK.wait();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }
            LOCK.notifyAll();                    // 打完了也要唤醒对方，让它看到 next > MAX 后退出
        }
    }
}
```

两个线程谁先启动都没关系：先进来的如果没轮到，就在 `wait` 中释放锁让对方执行。`wait` / `notify` 必须在持有同一把锁时调用，否则抛 `IllegalMonitorStateException`。

### 2、ReentrantLock + Condition

```java
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

public class OddEvenCondition {
    private static final int MAX = 10;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition oddTurn = lock.newCondition();
    private final Condition evenTurn = lock.newCondition();
    private int next = 1;

    public static void main(String[] args) throws InterruptedException {
        OddEvenCondition printer = new OddEvenCondition();
        Thread odd = new Thread(() -> printer.print(true), "odd");
        Thread even = new Thread(() -> printer.print(false), "even");
        odd.start();
        even.start();
        odd.join();
        even.join();
    }

    private void print(boolean isOdd) {
        Condition mine = isOdd ? oddTurn : evenTurn;
        Condition other = isOdd ? evenTurn : oddTurn;
        lock.lock();
        try {
            while (next <= MAX) {
                if ((next % 2 == 1) == isOdd) {
                    System.out.println(Thread.currentThread().getName() + ": " + next++);
                    other.signal();              // 只唤醒对方，不会惊动同一方
                } else {
                    mine.await();
                }
            }
            other.signal();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            lock.unlock();
        }
    }
}
```

和第 1 种写法逻辑相同，区别是奇偶各有一个条件队列，可以精确唤醒；`unlock` 一定放在 `finally` 里。`Condition` 的原理见 [显式锁（Lock）](/java/25_topic_lock#四、condition)。

### 3、Semaphore

```java
import java.util.concurrent.Semaphore;

public class OddEvenSemaphore {
    private static final int MAX = 10;
    private static final Semaphore ODD = new Semaphore(1);   // 奇数先打，初始 1 个许可
    private static final Semaphore EVEN = new Semaphore(0);

    public static void main(String[] args) throws InterruptedException {
        Thread odd = new Thread(() -> print(1, ODD, EVEN), "odd");
        Thread even = new Thread(() -> print(2, EVEN, ODD), "even");
        odd.start();
        even.start();
        odd.join();
        even.join();
    }

    private static void print(int start, Semaphore mine, Semaphore other) {
        for (int i = start; i <= MAX; i += 2) {
            try {
                mine.acquire();                  // 拿到自己的许可才打印
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            System.out.println(Thread.currentThread().getName() + ": " + i);
            other.release();                     // 把许可交给对方
        }
    }
}
```

每个线程自己知道要打哪些数，两个信号量像一根接力棒在线程间传递，没有共享计数器，也就没有「判断条件」可写错。`release` 不要求调用者先 `acquire` 过，正好用来把许可交给另一个线程。

---

## 三、两个线程交替打印 1A2B3C

题目：一个线程打印 `1234567`，另一个打印 `ABCDEFG`，输出 `1A2B3C4D5E6F7G`。

上一节三种写法换掉打印内容即可直接套用，这里给出 `LockSupport` 版本，它不需要锁对象，直接按线程唤醒：

```java
import java.util.concurrent.locks.LockSupport;

public class NumLetterPark {
    private static volatile int turn = 0;        // 0 轮到数字，1 轮到字母
    private static Thread numThread;
    private static Thread letterThread;

    public static void main(String[] args) throws InterruptedException {
        char[] nums = "1234567".toCharArray();
        char[] letters = "ABCDEFG".toCharArray();

        numThread = new Thread(() -> {
            for (char c : nums) {
                while (turn != 0) {
                    LockSupport.park();          // park 可能无故返回，所以放在 while 里
                }
                System.out.print(c);
                turn = 1;
                LockSupport.unpark(letterThread);
            }
        });
        letterThread = new Thread(() -> {
            for (char c : letters) {
                while (turn != 1) {
                    LockSupport.park();
                }
                System.out.print(c);
                turn = 0;
                LockSupport.unpark(numThread);
            }
        });
        numThread.start();
        letterThread.start();
        numThread.join();
        letterThread.join();
        System.out.println();                    // 1A2B3C4D5E6F7G
    }
}
```

网上常见的写法只有 `unpark` / `park` 没有 `turn` 标志，平时能跑对，但 `park` 允许无故返回，严格来说不正确。`turn` 是 `volatile`，一个线程写入后另一个线程立刻可见；`unpark` 先于 `park` 调用时许可会被保留，所以不会丢失唤醒。

---

## 四、多个线程按顺序执行

### 1、T1 → T2 → T3 各执行一次

最直接的是 `join`：后一个线程先等前一个线程结束。

```java
public class OrderedJoin {
    public static void main(String[] args) {
        Thread t1 = new Thread(() -> System.out.println("T1"));
        Thread t2 = new Thread(() -> {
            awaitDone(t1);                       // 等 T1 结束再执行
            System.out.println("T2");
        });
        Thread t3 = new Thread(() -> {
            awaitDone(t2);
            System.out.println("T3");
        });
        t1.start();
        t2.start();
        t3.start();
    }

    private static void awaitDone(Thread t) {
        try {
            t.join();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("被中断，放弃执行", e);
        }
    }
}
```

注意 `join` 只等已经启动的线程，对还没 `start` 的线程会立即返回，所以必须按 t1 → t2 → t3 启动；启动顺序不确定时，用下面的 `CountDownLatch` 写法（`OrderedLatch`）。

如果只要求「T1 的某一步之后 T2 才能开始」，而不是等 T1 整个结束，用 `CountDownLatch` 做信号：

```java
import java.util.concurrent.CountDownLatch;

public class OrderedLatch {
    public static void main(String[] args) {
        CountDownLatch t1Done = new CountDownLatch(1);
        CountDownLatch t2Done = new CountDownLatch(1);

        Thread t3 = new Thread(() -> {
            await(t2Done);
            System.out.println("T3");
        });
        Thread t2 = new Thread(() -> {
            await(t1Done);
            System.out.println("T2");
            t2Done.countDown();
        });
        Thread t1 = new Thread(() -> {
            System.out.println("T1");
            t1Done.countDown();
        });
        t3.start();
        t2.start();
        t1.start();
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("被中断，放弃执行", e);
        }
    }
}
```

实际项目里不手动建线程，用 `CompletableFuture` 把三步串起来：

```java
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class OrderedFuture {
    public static void main(String[] args) {
        ExecutorService pool = Executors.newFixedThreadPool(3);
        try {
            CompletableFuture.runAsync(() -> System.out.println("T1"), pool)
                    .thenRunAsync(() -> System.out.println("T2"), pool)   // 前一步完成后才提交
                    .thenRunAsync(() -> System.out.println("T3"), pool)
                    .join();
        } finally {
            pool.shutdown();
        }
    }
}
```

另一种答法是 `Executors.newSingleThreadExecutor()` 依次提交三个任务，单线程池天然按提交顺序执行。

### 2、三个线程循环打印 ABC

题目：三个线程分别打印 A、B、C，循环 5 次，输出 `ABCABCABCABCABC`。线程数多于 2 时，用「当前轮次 + 每个线程一个 `Condition`」最清晰，线程数可以任意扩展：

```java
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

public class RoundRobinPrinter {
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition[] turns;
    private final int rounds;
    private int current = 0;                     // 轮到第几个线程

    public RoundRobinPrinter(int threads, int rounds) {
        this.rounds = rounds;
        this.turns = new Condition[threads];
        for (int i = 0; i < threads; i++) {
            turns[i] = lock.newCondition();      // 每个线程一个条件队列，精确唤醒下一个
        }
    }

    public void print(int id, String text) {
        lock.lock();
        try {
            for (int r = 0; r < rounds; r++) {
                while (current != id) {
                    turns[id].await();
                }
                System.out.print(text);
                current = (id + 1) % turns.length;
                turns[current].signal();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            lock.unlock();
        }
    }

    public static void main(String[] args) throws InterruptedException {
        String[] names = {"A", "B", "C"};
        RoundRobinPrinter printer = new RoundRobinPrinter(names.length, 5);
        Thread[] threads = new Thread[names.length];
        for (int i = 0; i < names.length; i++) {
            int id = i;
            threads[i] = new Thread(() -> printer.print(id, names[id]));
            threads[i].start();
        }
        for (Thread t : threads) {
            t.join();
        }
        System.out.println();                    // ABCABCABCABCABC
    }
}
```

用 `synchronized` 写同样可行，但只有一个等待队列，必须 `notifyAll` 把所有线程叫醒、没轮到的再睡回去；线程一多，无效唤醒就多。

---

## 五、CountDownLatch 与 CyclicBarrier：赛跑

### 1、CountDownLatch：发令枪 + 终点线

题目：5 名选手同时起跑，全部到达后裁判宣布结束。用两个 `CountDownLatch`：一个计数 1 当发令枪，一个计数 5 当终点线。

```java
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;

public class RaceLatch {
    public static void main(String[] args) throws InterruptedException {
        int runners = 5;
        CountDownLatch startGun = new CountDownLatch(1);         // 发令枪：裁判扣一次，所有人同时起跑
        CountDownLatch finishLine = new CountDownLatch(runners); // 终点：每到一个人减 1
        AtomicInteger rank = new AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(runners);

        for (int i = 1; i <= runners; i++) {
            int id = i;
            pool.execute(() -> {
                try {
                    startGun.await();
                    Thread.sleep(ThreadLocalRandom.current().nextInt(100, 500));
                    System.out.println("选手" + id + " 到达，名次 " + rank.incrementAndGet());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    finishLine.countDown();                     // 放在 finally，出异常也不会让裁判永远等下去
                }
            });
        }
        System.out.println("预备，跑！");
        startGun.countDown();
        finishLine.await();
        System.out.println("全部到达");
        pool.shutdown();
    }
}
```

### 2、CyclicBarrier：多轮集合

题目变体：所有选手就位后才发令，全部到达后再统一宣布。这是「一组线程互相等待、分阶段推进」，适合可循环使用的 `CyclicBarrier`：

```java
import java.util.concurrent.BrokenBarrierException;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;

public class RaceBarrier {
    public static void main(String[] args) {
        int runners = 5;
        AtomicInteger phase = new AtomicInteger();
        // 屏障动作由最后一个到达的线程执行，执行完才放行所有人
        CyclicBarrier barrier = new CyclicBarrier(runners,
                () -> System.out.println(phase.incrementAndGet() == 1 ? "全员就位，开跑" : "全员到达，比赛结束"));
        // 线程数必须不少于参与方数，否则先到的线程占满线程池，后面的任务永远轮不到
        ExecutorService pool = Executors.newFixedThreadPool(runners);

        for (int i = 1; i <= runners; i++) {
            int id = i;
            pool.execute(() -> {
                try {
                    Thread.sleep(ThreadLocalRandom.current().nextInt(50, 300));
                    System.out.println("选手" + id + " 就位");
                    barrier.await();                            // 第一轮：等所有人就位
                    Thread.sleep(ThreadLocalRandom.current().nextInt(100, 500));
                    System.out.println("选手" + id + " 到达");
                    barrier.await();                            // 第二轮：屏障自动重置后复用
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } catch (BrokenBarrierException e) {
                    System.out.println("选手" + id + "：有人中途退出，屏障已破损");
                }
            });
        }
        pool.shutdown();
    }
}
```

| 对比 | CountDownLatch | CyclicBarrier |
|------|----------------|---------------|
| 谁等谁 | 一个或多个线程等其他线程把计数减到 0 | 参与的线程互相等待 |
| 能否复用 | 一次性 | 每轮结束自动重置 |
| 到齐后的动作 | 无 | 构造时可传一个屏障动作 |
| 有人出异常 | 不影响其他线程，计数可能永远减不到 0 | 屏障破损，其余线程收到 `BrokenBarrierException` |

两者的原理与更多用法见 [同步工具类](/java/27_topic_juc_tools)；阶段数或参与方数会变化时用 `Phaser`。

---

## 六、多个任务谁先成功用谁

题目：同时向三个数据源查询，返回第一个**成功**的结果，全部失败才报错，整体不超过 1 秒。

`CompletableFuture.anyOf` 返回的是第一个**完成**的结果，失败也算完成：最快的那个如果抛了异常，`anyOf` 直接失败。要「第一个成功」，需要自己组合：

```java
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class AnySuccess {

    /** 第一个成功的结果；全部失败时以最后一个异常失败。 */
    static <T> CompletableFuture<T> anySuccess(List<CompletableFuture<T>> futures) {
        CompletableFuture<T> result = new CompletableFuture<>();
        if (futures.isEmpty()) {
            result.completeExceptionally(new IllegalArgumentException("没有任务"));
            return result;
        }
        AtomicInteger failures = new AtomicInteger();
        for (CompletableFuture<T> f : futures) {
            f.whenComplete((value, ex) -> {
                if (ex == null) {
                    result.complete(value);                     // 只有第一次 complete 生效
                } else if (failures.incrementAndGet() == futures.size()) {
                    result.completeExceptionally(ex);
                }
            });
        }
        return result;
    }

    public static void main(String[] args) {
        ExecutorService pool = Executors.newFixedThreadPool(3);
        try {
            List<CompletableFuture<String>> calls = List.of(
                    CompletableFuture.supplyAsync(() -> query("主节点", 300, false), pool),
                    CompletableFuture.supplyAsync(() -> query("备节点", 100, true), pool),
                    CompletableFuture.supplyAsync(() -> query("缓存", 200, false), pool));
            String winner = anySuccess(calls)
                    .orTimeout(1, TimeUnit.SECONDS)             // 整体兜底超时
                    .join();
            System.out.println(winner);                         // 缓存：备节点最快但失败了
        } finally {
            pool.shutdownNow();
        }
    }

    static String query(String name, long millis, boolean fail) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new CompletionException(e);
        }
        if (fail) {
            throw new IllegalStateException(name + " 调用失败");
        }
        return name;
    }
}
```

`complete` 只有第一次调用返回 true，后面的成功结果会被忽略，所以不需要额外加锁。拿到结果后还在跑的任务不会自动停止，对 `CompletableFuture` 调用 `cancel(true)` 也**不会中断**执行线程，这里用 `shutdownNow` 中断池中的线程。

如果任务本来就是提交给线程池的，`ExecutorService.invokeAny` 正好实现了这个语义，还会取消其余任务：

```java
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class AnySuccessInvokeAny {
    public static void main(String[] args) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(3);
        try {
            List<Callable<String>> tasks = List.of(
                    () -> AnySuccess.query("主节点", 300, false),
                    () -> AnySuccess.query("备节点", 100, true),
                    () -> AnySuccess.query("缓存", 200, false));
            // 返回第一个正常完成的结果，并中断其余任务；全部失败抛 ExecutionException，超时抛 TimeoutException
            String winner = pool.invokeAny(tasks, 1, TimeUnit.SECONDS);
            System.out.println(winner);
        } finally {
            pool.shutdownNow();
        }
    }
}
```

`anyOf` / `allOf`、超时与取消的细节见 [CompletableFuture](/java/29_topic_completable_future#六、超时与取消)。

---

## 七、线程池任务超时

题目：提交到线程池的任务超过 500 毫秒没结果就放弃，并且不要让它继续占着线程。

### 1、单个任务：Future.get 超时 + cancel

```java
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public class TaskTimeout {
    public static void main(String[] args) throws InterruptedException {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Future<String> future = pool.submit(() -> {
            Thread.sleep(2_000);                                // 模拟慢调用；sleep 能响应中断
            return "done";
        });
        try {
            System.out.println(future.get(500, TimeUnit.MILLISECONDS));
        } catch (TimeoutException e) {
            future.cancel(true);                                // 中断执行线程，释放池里的线程
            System.out.println("超时，已取消：" + future.isCancelled());
        } catch (ExecutionException e) {
            System.out.println("任务失败：" + e.getCause());
        } finally {
            pool.shutdown();
            pool.awaitTermination(5, TimeUnit.SECONDS);
        }
    }
}
```

`get` 超时只是调用方不再等，任务本身还在跑；必须 `cancel(true)` 才会向执行线程发中断。

### 2、一批任务：invokeAll 统一截止时间

```java
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

public class BatchTimeout {
    public static void main(String[] args) throws InterruptedException {
        ExecutorService pool = Executors.newFixedThreadPool(3);
        List<Callable<String>> tasks = List.of(
                () -> work("A", 100),
                () -> work("B", 2_000),
                () -> work("C", 300));
        try {
            // 到期后还没完成的任务会被 cancel(true)
            List<Future<String>> futures = pool.invokeAll(tasks, 1, TimeUnit.SECONDS);
            for (Future<String> f : futures) {
                try {
                    System.out.println(f.get());
                } catch (CancellationException e) {
                    System.out.println("超时被取消");
                } catch (ExecutionException e) {
                    System.out.println("失败：" + e.getCause());
                }
            }
        } finally {
            pool.shutdownNow();
        }
    }

    static String work(String name, long millis) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(millis);
        while (System.nanoTime() < deadline) {
            // CPU 密集循环不会被 cancel 打断，要自己检查中断标志
            if (Thread.currentThread().isInterrupted()) {
                throw new InterruptedException(name + " 被取消");
            }
        }
        return name;
    }
}
```

要点：

- 取消靠中断，是协作式的：`sleep`、`wait`、阻塞队列等方法会响应中断，纯计算循环要自己检查 `isInterrupted()`，平台线程阻塞在传统 Socket IO 上不响应中断（虚拟线程被中断会关闭 socket 并抛 `SocketException`），要给 IO 本身设超时
- `CompletableFuture` 的 `orTimeout` / `completeOnTimeout` 只让结果按时完成，不会中断底层任务
- HTTP、数据库调用优先用客户端自带的连接 / 读超时，比在外层取消更可靠

中断的正确处理见 [线程基础](/java/23_topic_thread_basics#四、中断-协作式取消)，线程池的提交与异常处理见 [线程池](/java/28_topic_thread_pool#二、任务提交与异常处理)。

---

## 八、LRU 缓存

题目：实现容量固定的 LRU（最近最少使用）缓存，`get` / `put` 都是 O(1)，满了淘汰最久没被访问的条目。

### 1、LinkedHashMap 版

`LinkedHashMap` 开启访问顺序后，每次访问都把条目移到链表尾部，再重写 `removeEldestEntry` 就能自动淘汰：

```java
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

public class LinkedLru<K, V> extends LinkedHashMap<K, V> {
    private final int capacity;

    public LinkedLru(int capacity) {
        super(16, 0.75f, true);                                 // accessOrder = true：按访问顺序排列
        this.capacity = capacity;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > capacity;                               // 插入后超出容量就删掉最久未访问的
    }

    public static void main(String[] args) {
        Map<Integer, String> cache = Collections.synchronizedMap(new LinkedLru<>(2));
        cache.put(1, "one");
        cache.put(2, "two");
        cache.get(1);
        cache.put(3, "three");
        System.out.println(cache.keySet());                     // [1, 3]
    }
}
```

访问顺序模式下 `get` 也会修改链表，多线程使用必须整体加锁，这里用 `Collections.synchronizedMap` 包装。原理见 [集合框架](/java/21_topic_collection#七、linkedhashmap)。

### 2、手写版：HashMap + 双向链表

面试官通常要求不用 `LinkedHashMap`。思路：`HashMap` 负责 O(1) 定位节点，双向链表负责 O(1) 调整顺序，头尾各放一个哨兵节点省掉判空：

```java
import java.util.HashMap;
import java.util.Map;

public class LruCache<K, V> {

    private static final class Node<K, V> {
        final K key;
        V value;
        Node<K, V> prev;
        Node<K, V> next;

        Node(K key, V value) {
            this.key = key;
            this.value = value;
        }
    }

    private final int capacity;
    private final Map<K, Node<K, V>> index = new HashMap<>();
    private final Node<K, V> head = new Node<>(null, null);   // 哨兵：head.next 是最近使用的
    private final Node<K, V> tail = new Node<>(null, null);   // 哨兵：tail.prev 是最久未使用的

    public LruCache(int capacity) {
        if (capacity <= 0) {
            throw new IllegalArgumentException("capacity must be positive");
        }
        this.capacity = capacity;
        head.next = tail;
        tail.prev = head;
    }

    public synchronized V get(K key) {
        Node<K, V> node = index.get(key);
        if (node == null) {
            return null;
        }
        moveToFront(node);                                      // 读也要调整顺序，所以 get 同样要加锁
        return node.value;
    }

    public synchronized void put(K key, V value) {
        Node<K, V> node = index.get(key);
        if (node != null) {
            node.value = value;
            moveToFront(node);
            return;
        }
        if (index.size() == capacity) {
            Node<K, V> eldest = tail.prev;
            unlink(eldest);
            index.remove(eldest.key);                           // 节点里存 key，就是为了这里能删索引
        }
        node = new Node<>(key, value);
        index.put(key, node);
        addFirst(node);
    }

    public synchronized int size() {
        return index.size();
    }

    private void moveToFront(Node<K, V> node) {
        unlink(node);
        addFirst(node);
    }

    private void unlink(Node<K, V> node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }

    private void addFirst(Node<K, V> node) {
        node.prev = head;
        node.next = head.next;
        head.next.prev = node;
        head.next = node;
    }

    public static void main(String[] args) {
        LruCache<Integer, String> cache = new LruCache<>(2);
        cache.put(1, "one");
        cache.put(2, "two");
        cache.get(1);                                           // 1 变成最近使用
        cache.put(3, "three");                                  // 淘汰最久未用的 2
        System.out.println(cache.get(2));                       // null
        System.out.println(cache.get(1));                       // one
        System.out.println(cache.get(3));                       // three
    }
}
```

几个容易被追问的点：

- 节点里为什么要存 key：淘汰尾节点时要用它反查并删除 `HashMap` 里的索引
- 为什么不能用读写锁让 `get` 并发：`get` 会移动节点，本身就是写操作
- 高并发下单把锁是瓶颈：生产环境的本地缓存直接用 Caffeine，它用环形缓冲区记录访问、异步批量调整顺序，淘汰算法是比 LRU 命中率更高的 W-TinyLFU，见 [Caffeine](/cache/7_caffeine)

---

## 小结

- 协作类题目的骨架：共享状态表示轮次，等待条件写在 `while` 里，改完状态再唤醒，退出前唤醒对方
- 两个线程轮流：`wait` / `notifyAll`、`Condition`、`Semaphore` 都可以，`Semaphore` 传许可最不容易写错；多个线程轮流用每线程一个 `Condition`
- 按序执行：`join` 等线程结束，`CountDownLatch` 传信号，项目中用 `CompletableFuture` 串联
- `CountDownLatch` 一次性、一方等多方；`CyclicBarrier` 可循环、多方互等，线程池大小不能少于参与方数
- 「第一个成功」不能用 `anyOf`，要自己组合或用 `invokeAny`；超时后记得取消，取消靠中断，任务要能响应中断
- LRU：`LinkedHashMap` 访问顺序 + `removeEldestEntry`，或手写 `HashMap` + 双向链表；生产用 Caffeine

## 参考资料

- Java 21 `java.util.concurrent` 包说明：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/package-summary.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/package-summary.html)
- Java 21 `Object.wait` API（虚假唤醒说明）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Object.html#wait(long,int)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Object.html#wait(long,int))
- Java 21 `Condition` API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/Condition.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/Condition.html)
- Java 21 `LockSupport` API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/LockSupport.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/LockSupport.html)
- Java 21 `CyclicBarrier` API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CyclicBarrier.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CyclicBarrier.html)
- Java 21 `ExecutorService` API（invokeAny / invokeAll）：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ExecutorService.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ExecutorService.html)
- Java 21 `LinkedHashMap` API：[https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/LinkedHashMap.html](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/LinkedHashMap.html)
- LeetCode 146 LRU 缓存：[https://leetcode.cn/problems/lru-cache/](https://leetcode.cn/problems/lru-cache/)

> 返回：[数据结构与算法总览](../0_overview)
