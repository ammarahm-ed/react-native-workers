package ammarahmed.reactnativeworkers.example

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

/**
 * A loopback HTTP endpoint for the on-device isolation tests.
 *
 * Those two tests are about RN's networking DEVICE events — `didReceiveNetwork*`
 * — so they need a real request against a real server. In a dev build that is
 * Metro, reached through the origin of `SourceCode.scriptURL`. A release bundle
 * has no such origin (`scriptURL` is `assets://index.android.bundle`), and the
 * tests must not quietly skip there: skipping is indistinguishable from passing,
 * which is exactly the green-but-meaningless suite the tests were written to
 * avoid.
 *
 * So the app serves the endpoint itself. Nothing about what the tests measure
 * depends on WHO answers — only that the exchange is a genuine one, going
 * through RN's networking module and producing the same device events.
 *
 * Test-support only; not part of the library.
 */
class TestHttpServerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var server: ServerSocket? = null
  private var port = -1

  override fun getName() = NAME

  /** Starts the server if it is not already up, and returns its origin. */
  @ReactMethod
  fun start(promise: Promise) {
    synchronized(this) {
      if (server != null) {
        promise.resolve(origin())
        return
      }
      try {
        // Port 0 lets the kernel pick a free port, so a second instance of the
        // app (or anything else on the device) can never collide with us.
        // Bound to the loopback ADDRESS rather than the wildcard, so this never
        // listens on an interface anything off-device can reach.
        val socket = ServerSocket(0, BACKLOG, InetAddress.getByName(LOOPBACK))
        server = socket
        port = socket.localPort
        thread(name = "rnworkers-test-http", isDaemon = true) { acceptLoop(socket) }
        promise.resolve(origin())
      } catch (err: Throwable) {
        promise.reject("E_TEST_HTTP_SERVER", err.message, err)
      }
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    synchronized(this) {
      val socket = server
      server = null
      port = -1
      try {
        socket?.close()
        promise.resolve(true)
      } catch (err: Throwable) {
        promise.reject("E_TEST_HTTP_SERVER", err.message, err)
      }
    }
  }

  private fun origin() = "http://$LOOPBACK:$port"

  private fun acceptLoop(socket: ServerSocket) {
    while (!socket.isClosed) {
      val client =
        try {
          socket.accept()
        } catch (_: Throwable) {
          // Closed by stop(), or the process is going away.
          return
        }
      try {
        serve(client)
      } catch (_: Throwable) {
        // One malformed request must not take the accept loop down with it —
        // the tests would then fail for a reason that has nothing to do with
        // what they measure.
      } finally {
        runCatching { client.close() }
      }
    }
  }

  /**
   * Answers every path with 200 `ok`. The tests only need a response to exist
   * and to be attributable by URL, so there is nothing to route.
   */
  private fun serve(client: Socket) {
    client.soTimeout = READ_TIMEOUT_MS
    val reader =
      BufferedReader(InputStreamReader(client.getInputStream(), Charsets.ISO_8859_1))
    // Consume the request line and every header. The body is not read: these are
    // GETs, and RN's requests always carry a Content-Length of 0.
    var line = reader.readLine()
    while (!line.isNullOrEmpty()) {
      line = reader.readLine()
    }

    val body = "ok"
    val response =
      "HTTP/1.1 200 OK\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "Content-Length: ${body.toByteArray(Charsets.UTF_8).size}\r\n" +
        // No keep-alive: each request gets its own connection, so the tests
        // never depend on connection reuse to observe a completion event.
        "Connection: close\r\n" +
        "\r\n" +
        body
    client.getOutputStream().apply {
      write(response.toByteArray(Charsets.ISO_8859_1))
      flush()
    }
  }

  companion object {
    const val NAME = "TestHttpServer"
    private const val LOOPBACK = "127.0.0.1"
    private const val BACKLOG = 16
    private const val READ_TIMEOUT_MS = 5_000
  }
}
