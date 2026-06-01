# 基本概述

## 一、什么是微服务？

- 微服务架构是一个分布式系统，按照业务进行划分成为不同的服务单元，解决单体系统性能等不足。
- 微服务是一种架构风格，一个大型软件应用由多个服务单元组成。系统中的服务单元可以单独部署，各个服务单元之间是松耦合的。

> 微服务概念起源：[Microservices](https://martinfowler.com/articles/microservices.html)

> 通信方案详见：[服务间通信](./5_service_communication.md)

## 二、微服务之间的通讯方案

### 1、同步方案：HTTP/RPC

#### REST HTTP 协议

**REST** 请求在微服务中是最为常用的一种通讯方式，它依赖于 **HTTP\HTTPS** 协议。**RESTFUL** 的特点是：

- 每一个 URI 代表 1 种资源
- 客户端使用 **GET、POST、PUT、DELETE** 等操作方式对服务端资源进行操作：
    - GET 用来获取资源，
    - POST 用来新建资源（也可以用于更新资源），
    - PUT 用来更新资源，
    - DELETE 用来删除资源
- 通过操作资源的表现形式来操作资源
- 资源的表现形式是 XML 或者 HTML
- 客户端与服务端之间的交互在请求之间是无状态的,从客户端到服务端的每个请求都必须包含理解请求所必需的信息

**举例说明**：有一个服务方提供了如下接口：

```java

@RestController
@RequestMapping("/communication")
public class RestControllerDemo {
    @GetMapping("/hello")
    public String s() {
        return "hello";
    }
}
```

另外一个服务需要去调用该接口，调用方只需要根据 API 文档发送请求即可获取返回结果。

```java

@RestController
@RequestMapping("/demo")
public class RestDemo {
    @Autowired
    RestTemplate restTemplate;

    @GetMapping("/hello2")
    public String s2() {
        String forObject = restTemplate.getForObject("http://localhost:9013/communication/hello", String.class);
        return forObject;
    }
}
```

通过这样的方式可以实现服务之间的通讯。

#### RPC TCP 协议

**RPC (Remote Procedure Call)** 远程过程调用，简单的理解是一个节点请求另一个节点提供的服务。它的工作流程是这样的：

- 执行客户端调用语句，传送参数
- 调用本地系统发送网络消息
- 消息传送到远程主机
- 服务器得到消息并取得参数
- 根据调用请求以及参数执行远程过程（服务）
- 执行过程完毕，将结果返回服务器句柄
- 服务器句柄返回结果，调用远程主机的系统网络服务发送结果
- 消息传回本地主机
- 客户端句柄由本地主机的网络服务接收消息
- 客户端接收到调用语句返回的结果数据

**举例说明**： 首先需要一个服务端：

```java
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * RPC 服务端用来注册远程方法的接口和实现类
 */
public class RPCServer {
    private static ExecutorService executor = Executors.newFixedThreadPool(Runtime.getRuntime().availableProcessors());

    private static final ConcurrentHashMap<String, Class> serviceRegister = new ConcurrentHashMap<>();

    /**
     * 注册方法
     * @param service
     * @param impl
     */
    public void register(Class service, Class impl) {
        serviceRegister.put(service.getSimpleName(), impl);
    }

    /**
     * 启动方法
     * @param port
     */
    public void start(int port) {
        ServerSocket socket = null;
        try {
            socket = new ServerSocket();
            socket.bind(new InetSocketAddress(port));
            System.out.println("Service 服务启动");
            System.out.println(serviceRegister);
            while (true) {
                executor.execute(new Task(socket.accept()));
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            if (socket != null) {
                try {
                    socket.close();
                } catch (IOException e) {
                    e.printStackTrace();
                }
            }
        }
    }

    private static class Task implements Runnable {
        Socket client = null;

        public Task(Socket client) {
            this.client = client;
        }

        @Override
        public void run() {
            ObjectInputStream input = null;
            ObjectOutputStream output = null;
            try {
                input = new ObjectInputStream(client.getInputStream());
                // 按照顺序读取对方写过来的内容
                String serviceName = input.readUTF();
                String methodName = input.readUTF();
                Class<?>[] parameterTypes = (Class<?>[]) input.readObject();
                Object[] arguments = (Object[]) input.readObject();
                Class serviceClass = serviceRegister.get(serviceName);
                if (serviceClass == null) {
                    throw new ClassNotFoundException(serviceName + " 没有找到!");
                }
                Method method = serviceClass.getMethod(methodName, parameterTypes);
                Object result = method.invoke(serviceClass.newInstance(), arguments);

                output = new ObjectOutputStream(client.getOutputStream());
                output.writeObject(result);
            } catch (Exception e) {
                e.printStackTrace();

            } finally {
                try {
                    // 这里就不写 output!=null才关闭这个逻辑了
                    output.close();
                    input.close();
                    client.close();
                } catch (IOException e) {
                    e.printStackTrace();
                }

            }
        }
    }

}

```

其次需要一个客户端：

```java
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * RPC 客户端
 */
public class RPCclient<T> {
    /**
     * 通过动态代理将参数发送过去到 RPCServer ,RPCserver 返回结果这个方法处理成为正确的实体
     */
    public static <T> T getRemoteProxyObj(final Class<T> service, final InetSocketAddress addr) {

        return (T) Proxy.newProxyInstance(service.getClassLoader(), new Class<?>[]{service}, new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {

                Socket socket = null;
                ObjectOutputStream out = null;
                ObjectInputStream input = null;
                try {
                    socket = new Socket();
                    socket.connect(addr);

                    // 将实体类,参数,发送给远程调用方
                    out = new ObjectOutputStream(socket.getOutputStream());
                    out.writeUTF(service.getSimpleName());
                    out.writeUTF(method.getName());
                    out.writeObject(method.getParameterTypes());
                    out.writeObject(args);

                    input = new ObjectInputStream(socket.getInputStream());
                    return input.readObject();
                } catch (Exception e) {
                    e.printStackTrace();
                } finally {
                    out.close();
                    input.close();
                    socket.close();
                }
                return null;
            }
        });

    }

}

```

再来一个测试的远程方法。

```java
public interface Tinterface {
    String send(String msg);
}

public class TinterfaceImpl implements Tinterface {
    @Override
    public String send(String msg) {
        return "send message " + msg;
    }
}

```

测试代码如下：

```java
import java.net.InetSocketAddress;


public class RunTest {
    public static void main(String[] args) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                RPCServer rpcServer = new RPCServer();
                rpcServer.register(Tinterface.class, TinterfaceImpl.class);
                rpcServer.start(10000);
            }
        }).start();
        Tinterface tinterface = RPCclient.getRemoteProxyObj(Tinterface.class, new InetSocketAddress("localhost", 10000));
        System.out.println(tinterface.send("rpc 测试用例"));

    }
}

```

输出 `send message rpc 测试用例` 。

### 2、异步方案：消息中间件

常见的消息中间件有 Kafka、ActiveMQ、RabbitMQ、RocketMQ ，常见的协议有 AMQP、MQTTP、STOMP、XMPP。这里不对消息队列进行拓展了，具体如何使用还是请移步官网。

### 3、HTTP和RPC对比

RPC 和 HTTP 主要区别在于**通信方式、使用场景、性能、协议特性**等方面，具体对比如下：

#### **1. 概念与本质**

| **对比项** | **RPC（Remote Procedure Call）** | **HTTP（HyperText Transfer Protocol）** |
|---------|--------------------------------|---------------------------------------|
| **定义**  | 远程过程调用，像调用本地函数一样调用远程服务         | 超文本传输协议，主要用于 Web 交互                   |
| **目标**  | 让远程调用像本地调用一样透明                 | 规定数据如何在客户端和服务器之间传输                    |

#### **2. 主要区别**

| **对比项**  | **RPC**                                | **HTTP**                     |
|----------|----------------------------------------|------------------------------|
| **通信方式** | 多种协议（TCP、UDP、HTTP/2 等）                 | 仅基于 HTTP/HTTPS               |
| **调用风格** | 以函数调用方式调用远程方法                          | 以 RESTful 方式访问资源（GET、POST 等） |
| **数据格式** | Protobuf、Thrift、MessagePack 等二进制格式，性能高 | JSON、XML，文本格式，可读性高但体积大       |
| **性能**   | 高效，数据序列化后传输，适合低延迟高并发                   | HTTP 头部大，序列化/反序列化开销较高，性能相对较低 |
| **适用场景** | 微服务内部通信（如 gRPC、Thrift）                 | Web 服务、第三方 API 调用            |
| **状态管理** | 可以支持长连接、流式通信（如 gRPC 的流模式）              | REST API 无状态，每次请求需重新建立连接     |
| **支持异步** | 支持（如 gRPC 支持 Async Stub）               | WebSocket、HTTP/2 Push 支持异步   |
| **开发方式** | 代码生成器自动生成客户端/服务端 Stub，调用透明             | 需要手写 HTTP 请求和解析响应            |

#### **3. 适用场景**

- **RPC 适用场景**
    - 微服务架构内部通信（如 gRPC 在 Kubernetes 中的服务间调用）
    - 低延迟、高吞吐的场景（如高频交易、游戏服务器通信）
    - 需要流式数据处理（如 gRPC 双向流式通信）

- **HTTP 适用场景**
    - Web 服务和 API（如 RESTful API）
    - 跨平台通信（如移动端、前端与后端交互）
    - 需要良好可读性和调试性的场景（JSON 易读，方便调试）

#### **4. 总结**

- **RPC 更适合高性能、低延迟的微服务通信，通常用于后端服务间调用**，比如 gRPC、Thrift。
- **HTTP 更适合 Web API 和外部开放接口，适用范围更广，但性能相对低**，如 RESTful API。

如果你的业务是 **微服务内部通信**，可以考虑 RPC（如 gRPC）；如果是 **对外提供 API**，HTTP（REST API）会更合适。

## 三、后续补充专题

- [服务治理](./10_service_governance)：注册发现、流量治理、稳定性治理、版本兼容

