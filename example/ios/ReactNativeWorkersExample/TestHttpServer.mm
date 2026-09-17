#import <React/RCTBridgeModule.h>

#import <arpa/inet.h>
#import <netinet/in.h>
#import <stdio.h>
#import <string.h>
#import <sys/socket.h>
#import <sys/time.h>
#import <unistd.h>

/**
 * A loopback HTTP endpoint for the on-device isolation tests.
 *
 * Those two tests are about RN's networking DEVICE events — `didReceiveNetwork*`
 * — so they need a real request against a real server. In a dev build that is
 * Metro, reached through the origin of `SourceCode.scriptURL`. A release bundle
 * has no such origin (there `scriptURL` is a path to `main.jsbundle`), and the
 * tests must not quietly skip there: skipping is indistinguishable from passing,
 * which is exactly the green-but-meaningless suite the tests were written to
 * avoid.
 *
 * So the app serves the endpoint itself. Nothing about what the tests measure
 * depends on WHO answers — only that the exchange is a genuine one, going
 * through RN's networking module and producing the same device events.
 *
 * Deliberately not a TurboModule: `RCT_EXPORT_MODULE()` puts the class in
 * `RCTGetModuleClasses()` at load time, which is the registry the New
 * Architecture's TurboModule interop scans for legacy modules — so this needs no
 * entry in the app delegate. The Android counterpart is TestHttpServerModule.kt,
 * and the two must stay in step: same module name, same `start`/`stop` contract.
 *
 * Test-support only; not part of the library.
 */
@interface TestHttpServer : NSObject <RCTBridgeModule>
@end

@implementation TestHttpServer {
  int _listenFd;
  uint16_t _port;
  dispatch_queue_t _queue;
}

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  if (self = [super init]) {
    _listenFd = -1;
    _port = 0;
    _queue = dispatch_queue_create("com.ammarahmed.rnworkers.test-http", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

/** Starts the server if it is not already up, and resolves to its origin. */
RCT_EXPORT_METHOD(start
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  @synchronized(self) {
    if (_listenFd >= 0) {
      resolve([self origin]);
      return;
    }

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
      reject(@"E_TEST_HTTP_SERVER", @"socket() failed", nil);
      return;
    }

    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    // Port 0 lets the kernel pick a free port, so a second instance of the app
    // can never collide with us. Bound to the loopback ADDRESS rather than the
    // wildcard, so this never listens on an interface anything off-device can
    // reach.
    addr.sin_port = 0;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(fd, 16) != 0) {
      close(fd);
      reject(@"E_TEST_HTTP_SERVER", @"bind()/listen() failed", nil);
      return;
    }

    socklen_t len = sizeof(addr);
    if (getsockname(fd, (struct sockaddr *)&addr, &len) != 0) {
      close(fd);
      reject(@"E_TEST_HTTP_SERVER", @"getsockname() failed", nil);
      return;
    }

    _listenFd = fd;
    _port = ntohs(addr.sin_port);

    dispatch_async(_queue, ^{
      [self acceptLoop];
    });
    resolve([self origin]);
  }
}

RCT_EXPORT_METHOD(stop
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  @synchronized(self) {
    [self closeServer];
    resolve(@YES);
  }
}

- (NSString *)origin
{
  return [NSString stringWithFormat:@"http://127.0.0.1:%u", _port];
}

- (void)closeServer
{
  int fd = _listenFd;
  _listenFd = -1;
  _port = 0;
  if (fd >= 0) {
    // Closing the listening socket also unblocks the accept() in the queue's
    // loop, which then returns and lets the queue drain.
    close(fd);
  }
}

- (void)acceptLoop
{
  while (YES) {
    int fd;
    @synchronized(self) {
      fd = _listenFd;
    }
    if (fd < 0) {
      return;
    }

    int client = accept(fd, NULL, NULL);
    if (client < 0) {
      // Closed by stop(), or interrupted.
      return;
    }

    [self serve:client];
    close(client);
  }
}

/**
 * Answers every path with 200 `ok`. The tests only need a response to exist and
 * to be attributable by URL, so there is nothing to route.
 */
- (void)serve:(int)client
{
  struct timeval timeout;
  timeout.tv_sec = 5;
  timeout.tv_usec = 0;
  setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

  // Consume the request line and every header. The body is not read: these are
  // GETs, and RN's requests always carry a Content-Length of 0.
  NSMutableData *seen = [NSMutableData data];
  while (![self requestComplete:seen]) {
    char buf[1024];
    ssize_t n = read(client, buf, sizeof(buf));
    if (n <= 0) {
      return;
    }
    [seen appendBytes:buf length:(NSUInteger)n];
  }

  static const char *body = "ok";
  char response[256];
  int len = snprintf(response,
                     sizeof(response),
                     "HTTP/1.1 200 OK\r\n"
                     "Content-Type: text/plain; charset=utf-8\r\n"
                     "Content-Length: %zu\r\n"
                     // No keep-alive: each request gets its own connection, so
                     // the tests never depend on connection reuse to observe a
                     // completion event.
                     "Connection: close\r\n"
                     "\r\n"
                     "%s",
                     strlen(body),
                     body);
  if (len > 0) {
    ssize_t written = 0;
    while (written < len) {
      ssize_t n = write(client, response + written, (size_t)(len - written));
      if (n <= 0) {
        return;
      }
      written += n;
    }
  }
}

- (BOOL)requestComplete:(NSData *)data
{
  static const char delimiter[] = "\r\n\r\n";
  NSRange found = [data rangeOfData:[NSData dataWithBytes:delimiter length:4]
                            options:0
                              range:NSMakeRange(0, data.length)];
  return found.location != NSNotFound;
}

@end
