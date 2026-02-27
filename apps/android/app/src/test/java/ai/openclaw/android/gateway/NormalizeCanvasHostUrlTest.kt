package ai.openclaw.android.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Tests for [normalizeCanvasHostUrl] and related helpers.
 *
 * Regression guard for https://github.com/openclaw/openclaw/issues/20608:
 * IPv4 addresses must not trigger TLS upgrades on plain-HTTP connections.
 */
class NormalizeCanvasHostUrlTest {

  // --- IPv4 on plain HTTP (the issue scenario) ---

  @Test
  fun ipv4LanAddress_noTls_preservesOriginalUrl() {
    val ep = endpoint(host = "192.168.1.83", port = 18789)
    val result = normalizeCanvasHostUrl("http://192.168.1.83:18789", ep, isTlsConnection = false)
    assertEquals("http://192.168.1.83:18789", result)
  }

  @Test
  fun ipv4LanAddress_noTls_preservesCanvasPath() {
    val ep = endpoint(host = "192.168.1.83", port = 18789)
    val raw = "http://192.168.1.83:18789/_openclaw_/a2ui/"
    val result = normalizeCanvasHostUrl(raw, ep, isTlsConnection = false)
    assertEquals(raw, result)
  }

  @Test
  fun ipv4Address_noTls_doesNotUpgradeToHttps() {
    val ep = endpoint(host = "10.0.0.5", port = 18789)
    val result = normalizeCanvasHostUrl("http://10.0.0.5:18789", ep, isTlsConnection = false)
    assertEquals("http://10.0.0.5:18789", result)
  }

  // --- IPv4 with TLS ---

  @Test
  fun ipv4Address_withTls_rewritesToHttps() {
    val ep = endpoint(host = "192.168.1.83", port = 443)
    val result = normalizeCanvasHostUrl("http://192.168.1.83:18789", ep, isTlsConnection = true)
    assertEquals("https://192.168.1.83", result)
  }

  @Test
  fun ipv4Address_withTls_nonStandardPort() {
    val ep = endpoint(host = "192.168.1.83", port = 8443)
    val result = normalizeCanvasHostUrl("http://192.168.1.83:18789", ep, isTlsConnection = true)
    assertEquals("https://192.168.1.83:8443", result)
  }

  // --- Domain names ---

  @Test
  fun domainName_noTls_preservesOriginalUrl() {
    val ep = endpoint(host = "my-gateway.example.com", port = 18789)
    val result = normalizeCanvasHostUrl("http://my-gateway.example.com:18789", ep, isTlsConnection = false)
    assertEquals("http://my-gateway.example.com:18789", result)
  }

  @Test
  fun domainName_withTls_rewritesToHttpsOnPort443() {
    val ep = endpoint(host = "gateway.example.com", port = 443)
    val result = normalizeCanvasHostUrl("http://gateway.example.com:18789", ep, isTlsConnection = true)
    assertEquals("https://gateway.example.com", result)
  }

  // --- Loopback addresses ---

  @Test
  fun localhost_noTls_fallsBackToEndpointHost() {
    val ep = endpoint(host = "192.168.1.83", port = 18789)
    val result = normalizeCanvasHostUrl("http://localhost:18789", ep, isTlsConnection = false)
    assertEquals("http://192.168.1.83:18789", result)
  }

  @Test
  fun loopbackIp_noTls_fallsBackToEndpointHost() {
    val ep = endpoint(host = "10.0.0.5", port = 18789)
    val result = normalizeCanvasHostUrl("http://127.0.0.1:18789", ep, isTlsConnection = false)
    assertEquals("http://10.0.0.5:18789", result)
  }

  // --- Fallback: null/blank raw URL ---

  @Test
  fun nullRaw_noTls_fallsBackToEndpointHost() {
    val ep = endpoint(host = "192.168.1.83", port = 18789)
    val result = normalizeCanvasHostUrl(null, ep, isTlsConnection = false)
    assertEquals("http://192.168.1.83:18789", result)
  }

  @Test
  fun blankRaw_noTls_fallsBackToEndpointHost() {
    val ep = endpoint(host = "10.0.0.5", port = 18789)
    val result = normalizeCanvasHostUrl("  ", ep, isTlsConnection = false)
    assertEquals("http://10.0.0.5:18789", result)
  }

  @Test
  fun nullRaw_withTls_fallsBackToHttpsEndpoint() {
    val ep = endpoint(host = "192.168.1.83", port = 443)
    val result = normalizeCanvasHostUrl(null, ep, isTlsConnection = true)
    assertEquals("https://192.168.1.83", result)
  }

  // --- Fallback host priority: tailnetDns > lanHost > host ---

  @Test
  fun fallback_prefersTailnetDns() {
    val ep = endpoint(host = "10.0.0.5", port = 18789, tailnetDns = "gateway.tailnet.ts.net", lanHost = "192.168.1.83")
    val result = normalizeCanvasHostUrl(null, ep, isTlsConnection = false)
    assertEquals("http://gateway.tailnet.ts.net:18789", result)
  }

  @Test
  fun fallback_prefersLanHostOverHost() {
    val ep = endpoint(host = "10.0.0.5", port = 18789, lanHost = "192.168.1.83")
    val result = normalizeCanvasHostUrl(null, ep, isTlsConnection = false)
    assertEquals("http://192.168.1.83:18789", result)
  }

  // --- Canvas port ---

  @Test
  fun fallback_usesCanvasPortWhenNotTls() {
    val ep = endpoint(host = "192.168.1.83", port = 18789, canvasPort = 8080)
    val result = normalizeCanvasHostUrl(null, ep, isTlsConnection = false)
    assertEquals("http://192.168.1.83:8080", result)
  }

  @Test
  fun fallback_tls_ignoresCanvasPort() {
    val ep = endpoint(host = "192.168.1.83", port = 443, canvasPort = 8080)
    val result = normalizeCanvasHostUrl(null, ep, isTlsConnection = true)
    assertEquals("https://192.168.1.83", result)
  }

  // --- TLS rewrite preserves suffix ---

  @Test
  fun tlsRewrite_preservesPathAndQuery() {
    val ep = endpoint(host = "gateway.example.com", port = 443)
    val raw = "http://gateway.example.com:18789/_openclaw_/a2ui/?token=abc"
    val result = normalizeCanvasHostUrl(raw, ep, isTlsConnection = true)
    assertEquals("https://gateway.example.com/_openclaw_/a2ui/?token=abc", result)
  }

  // --- Already-correct HTTPS URL with TLS ---

  @Test
  fun alreadyHttps_matchingPort_noRewrite() {
    val ep = endpoint(host = "gateway.example.com", port = 443)
    val raw = "https://gateway.example.com"
    val result = normalizeCanvasHostUrl(raw, ep, isTlsConnection = true)
    assertEquals(raw, result)
  }

  // --- IPv6 ---

  @Test
  fun ipv6Address_noTls_preservesOriginalUrl() {
    val ep = endpoint(host = "::1", port = 18789)
    // Loopback IPv6 triggers fallback path
    val result = normalizeCanvasHostUrl("http://[::1]:18789", ep, isTlsConnection = false)
    // Fallback host is "::1" (loopback), so endpoint.host is used as-is
    assertEquals("http://[::1]:18789", result)
  }

  // --- isLoopbackHost helper ---

  @Test
  fun isLoopbackHost_localhost() {
    assertTrue(isLoopbackHost("localhost"))
  }

  @Test
  fun isLoopbackHost_127prefix() {
    assertTrue(isLoopbackHost("127.0.0.1"))
    assertTrue(isLoopbackHost("127.0.0.2"))
  }

  @Test
  fun isLoopbackHost_ipv6Loopback() {
    assertTrue(isLoopbackHost("::1"))
  }

  @Test
  fun isLoopbackHost_bindAll() {
    assertTrue(isLoopbackHost("0.0.0.0"))
    assertTrue(isLoopbackHost("::"))
  }

  @Test
  fun isLoopbackHost_lanIp_notLoopback() {
    assertFalse(isLoopbackHost("192.168.1.83"))
    assertFalse(isLoopbackHost("10.0.0.5"))
  }

  @Test
  fun isLoopbackHost_domain_notLoopback() {
    assertFalse(isLoopbackHost("example.com"))
    assertFalse(isLoopbackHost("gateway.local"))
  }

  @Test
  fun isLoopbackHost_null_notLoopback() {
    assertFalse(isLoopbackHost(null))
  }

  @Test
  fun isLoopbackHost_blank_notLoopback() {
    assertFalse(isLoopbackHost(""))
    assertFalse(isLoopbackHost("  "))
  }

  // --- buildCanvasUrl helper ---

  @Test
  fun buildCanvasUrl_httpsPort443_omitsPort() {
    assertEquals("https://example.com", buildCanvasUrl("example.com", "https", 443, ""))
  }

  @Test
  fun buildCanvasUrl_httpPort80_omitsPort() {
    assertEquals("http://example.com", buildCanvasUrl("example.com", "http", 80, ""))
  }

  @Test
  fun buildCanvasUrl_nonStandardPort_includesPort() {
    assertEquals("https://example.com:8443", buildCanvasUrl("example.com", "https", 8443, ""))
  }

  @Test
  fun buildCanvasUrl_ipv6_bracketWrapped() {
    assertEquals("http://[::1]:18789", buildCanvasUrl("::1", "http", 18789, ""))
  }

  @Test
  fun buildCanvasUrl_withSuffix() {
    assertEquals("https://example.com:8443/path?q=1", buildCanvasUrl("example.com", "https", 8443, "/path?q=1"))
  }

  // --- helpers ---

  private fun endpoint(
    host: String,
    port: Int,
    lanHost: String? = null,
    tailnetDns: String? = null,
    canvasPort: Int? = null,
  ) = GatewayEndpoint(
    stableId = "test|${host.lowercase()}|$port",
    name = "$host:$port",
    host = host,
    port = port,
    lanHost = lanHost,
    tailnetDns = tailnetDns,
    canvasPort = canvasPort,
  )
}
