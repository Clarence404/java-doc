# 大文件上传 & 对象存储

> 大文件上传涉及分片、断点续传、秒传等技术。生产环境通常配合对象存储（OSS/MinIO）使用，避免文件占用应用服务器资源。

---

## 一、普通上传的问题

直接将文件传给后端服务器的问题：

| 问题 | 说明 |
|------|------|
| 超时 | 大文件上传时间长，HTTP 连接超时 |
| 占用服务器内存/磁盘 | 文件先存服务器再转存，双倍 IO |
| 单次失败全部重传 | 网络中断后从头开始 |
| 无并发上传 | 串行上传速度慢 |

---

## 二、分片上传（Multipart Upload）

### 2.1 原理

将大文件切割为多个小块（Chunk），并发上传，最后合并。

```
文件（1GB）
    ↓ 切片（每片 5MB）
Chunk 1, Chunk 2, ..., Chunk 200
    ↓ 并发上传（多线程）
后端接收各片
    ↓ 合并
完整文件
```

### 2.2 前端实现

```javascript
async function uploadFile(file) {
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
    const chunks = Math.ceil(file.size / CHUNK_SIZE);
    const fileHash = await calcHash(file); // MD5 计算文件指纹

    // 询问后端哪些分片已上传（断点续传）
    const { uploadedChunks } = await axios.post('/upload/check', { fileHash, chunks });

    const uploadTasks = [];
    for (let i = 0; i < chunks; i++) {
        if (uploadedChunks.includes(i)) continue; // 已上传，跳过

        const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const formData = new FormData();
        formData.append('fileHash', fileHash);
        formData.append('chunkIndex', i);
        formData.append('chunk', chunk);

        uploadTasks.push(axios.post('/upload/chunk', formData));
    }

    // 并发上传（控制并发数，防止占满带宽）
    await Promise.all(uploadTasks.slice(0, 5)); // 最多 5 个并发

    // 通知后端合并
    await axios.post('/upload/merge', { fileHash, fileName: file.name, chunks });
}
```

### 2.3 后端实现

```java
// 接收分片
@PostMapping("/upload/chunk")
public Result uploadChunk(@RequestParam String fileHash,
                          @RequestParam int chunkIndex,
                          @RequestParam MultipartFile chunk) throws IOException {
    // 分片临时存储路径：/tmp/upload/{fileHash}/{chunkIndex}
    Path chunkPath = Paths.get(tmpDir, fileHash, String.valueOf(chunkIndex));
    Files.createDirectories(chunkPath.getParent());
    chunk.transferTo(chunkPath.toFile());

    // 记录已上传分片（Redis Set）
    redis.sadd("upload:chunks:" + fileHash, String.valueOf(chunkIndex));
    return Result.ok();
}

// 合并分片
@PostMapping("/upload/merge")
public Result merge(@RequestBody MergeRequest req) throws IOException {
    Path targetPath = Paths.get(uploadDir, req.getFileName());

    try (OutputStream out = Files.newOutputStream(targetPath)) {
        for (int i = 0; i < req.getChunks(); i++) {
            Path chunkPath = Paths.get(tmpDir, req.getFileHash(), String.valueOf(i));
            Files.copy(chunkPath, out);
        }
    }

    // 清理临时分片
    FileUtils.deleteDirectory(new File(tmpDir + "/" + req.getFileHash()));
    redis.delete("upload:chunks:" + req.getFileHash());

    return Result.ok(getFileUrl(req.getFileName()));
}
```

---

## 三、断点续传

### 3.1 原理

上传中断后，重新上传时跳过已上传的分片：

```java
// 检查已上传分片
@PostMapping("/upload/check")
public Result check(@RequestParam String fileHash, @RequestParam int totalChunks) {
    Set<String> uploadedChunks = redis.smembers("upload:chunks:" + fileHash);

    // 如果所有分片都已上传（可能是之前合并失败），直接返回秒传
    if (uploadedChunks.size() == totalChunks) {
        return Result.ok(Map.of("uploaded", true, "url", getFileUrl(fileHash)));
    }

    return Result.ok(Map.of(
        "uploaded", false,
        "uploadedChunks", uploadedChunks.stream().map(Integer::parseInt).collect(Collectors.toList())
    ));
}
```

---

## 四、秒传（文件指纹）

### 4.1 原理

上传前计算文件 MD5（或 SHA256）指纹，询问服务端该文件是否已存在。若已存在，直接返回 URL，无需重复上传。

```java
// 秒传检查（根据 MD5 判断文件是否已存在）
@GetMapping("/upload/instant")
public Result instantUpload(@RequestParam String fileHash) {
    String existingUrl = fileHashService.getUrl(fileHash);
    if (existingUrl != null) {
        return Result.ok(Map.of("instant", true, "url", existingUrl));
    }
    return Result.ok(Map.of("instant", false));
}
```

**存储结构**：维护 `fileHash → fileUrl` 的映射表，实现文件去重存储：

```sql
CREATE TABLE file_record (
    file_hash   VARCHAR(64) PRIMARY KEY,  -- MD5
    file_url    VARCHAR(512) NOT NULL,
    file_size   BIGINT,
    created_at  DATETIME
);
```

---

## 五、对象存储（OSS / MinIO）

### 5.1 为什么用对象存储

| 维度 | 自建服务器存文件 | 对象存储（OSS/MinIO）|
|------|---------------|---------------------|
| 存储成本 | 高（SSD 服务器） | 低（专用存储，按量付费）|
| 扩容 | 需要运维手动扩容 | 自动弹性扩容 |
| 可靠性 | 依赖 RAID/备份 | 多副本，99.9999999% 可靠 |
| 带宽 | 占用应用服务器带宽 | 独立带宽，可接 CDN |
| 功能 | 自己实现 | 内置图片处理/防盗链/回源 |

### 5.2 客户端直传（推荐架构）

传统方案：客户端 → 后端 → OSS（后端浪费带宽）

**推荐方案**：客户端直接上传到 OSS，后端只负责生成临时凭证：

```
1. 前端请求后端：获取 OSS 临时上传凭证（STS Token）
2. 后端调用 OSS 的 STS 接口，生成临时 AK/SK（有效期 15min）
3. 前端用临时凭证直接上传文件到 OSS
4. 上传成功后，OSS 回调后端（回调 URL），后端记录文件信息
```

```java
// 后端：生成阿里云 OSS STS 临时凭证
@GetMapping("/oss/sts-token")
public Result getStsToken() {
    DefaultAcsClient stsClient = buildStsClient();
    AssumeRoleRequest request = new AssumeRoleRequest()
        .setRoleArn("acs:ram::xxx:role/upload-role")
        .setRoleSessionName("upload-session")
        .setDurationSeconds(900L); // 15 分钟有效

    AssumeRoleResponse response = stsClient.getAcsResponse(request);
    Credentials credentials = response.getCredentials();

    return Result.ok(Map.of(
        "accessKeyId",     credentials.getAccessKeyId(),
        "accessKeySecret", credentials.getAccessKeySecret(),
        "securityToken",   credentials.getSecurityToken(),
        "expiration",      credentials.getExpiration(),
        "bucket",          ossBucket,
        "region",          ossRegion
    ));
}
```

### 5.3 MinIO（私有化部署）

MinIO 是兼容 S3 协议的开源对象存储，适合私有化部署：

```java
// MinIO Java SDK
MinioClient minioClient = MinioClient.builder()
    .endpoint("http://localhost:9000")
    .credentials("minioadmin", "minioadmin")
    .build();

// 上传文件
minioClient.uploadObject(UploadObjectArgs.builder()
    .bucket("my-bucket")
    .object("images/avatar.jpg")
    .filename("/tmp/avatar.jpg")
    .build());

// 生成预签名 URL（有时效的直传 URL）
String presignedUrl = minioClient.getPresignedObjectUrl(
    GetPresignedObjectUrlArgs.builder()
        .method(Method.PUT)
        .bucket("my-bucket")
        .object("uploads/file.pdf")
        .expiry(15, TimeUnit.MINUTES)
        .build());
```

---

## 六、图片处理

### 6.1 上传时处理

图片上传后，异步生成多种尺寸缩略图：

```java
// 消费图片上传事件，生成缩略图
@KafkaListener(topics = "image-upload")
public void processImage(String imageKey) {
    int[] sizes = {100, 300, 800}; // 缩略图尺寸
    for (int size : sizes) {
        byte[] thumbnail = imageProcessor.resize(imageKey, size, size);
        ossClient.putObject(bucket, imageKey + "_" + size + "w", thumbnail);
    }
}
```

### 6.2 CDN + 云端图片处理

阿里云 OSS / 腾讯 COS 支持 URL 参数动态处理图片，无需生成多份：

```
// 原图
https://cdn.example.com/images/photo.jpg

// 按宽度 300 等比缩放
https://cdn.example.com/images/photo.jpg?x-oss-process=image/resize,w_300

// 裁剪为 200x200 并加水印
https://cdn.example.com/images/photo.jpg?x-oss-process=image/crop,w_200,h_200/watermark,...
```

---

## 七、完整上传流程总结

```
1. 前端计算文件 MD5
2. 询问后端是否可以秒传 → 秒传成功则结束
3. 获取已上传分片列表（断点续传）
4. 申请 OSS 直传临时凭证
5. 分片并发直传到 OSS
6. 所有分片上传后，调用 OSS 合并接口
7. OSS 回调后端，后端记录文件信息
8. 返回文件访问 URL（CDN 地址）
```
