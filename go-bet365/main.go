package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"

	cycletls "github.com/Danny-Dasilva/CycleTLS/cycletls"
	utls "github.com/refraction-networking/utls"
)

func main() {
	raw := "wss://premws-pt5.365lpodds.com/zap/?uid=9513984667611814"

	u, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}

	h := http.Header{}
	h.Set("Origin", "https://www.bet365.com")
	h.Set("Referer", "https://www.bet365.com/") // sometimes checked
	h.Set("Sec-WebSocket-Protocol", "zap-protocol-v2")
	h.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36")
	h.Set("Accept-Language", "en-GB,en-US;q=0.9,en;q=0.8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Pragma", "no-cache")

	// If the WS requires auth, add cookies from a real browser session:
	// h.Set("Cookie", "YOUR_COOKIE_STRING")

	cfg := &utls.Config{
		ServerName: u.Hostname(),
	}

	ws := cycletls.NewWebSocketClient(cfg, h)

	conn, resp, err := ws.Connect(raw)
	if err != nil {
		fmt.Println("connect error:", err)

		if resp != nil {
			fmt.Println("handshake status:", resp.Status)
			fmt.Println("handshake headers:")
			for k, v := range resp.Header {
				fmt.Printf("  %s: %v\n", k, v)
			}

			// Read a small chunk of body, if any (often contains WAF clue)
			if resp.Body != nil {
				defer resp.Body.Close()
				b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
				b = bytes.TrimSpace(b)
				if len(b) > 0 {
					fmt.Println("handshake body (first 4KB):")
					fmt.Println(string(b))
				}
			}
		}

		return
	}
	defer conn.Close()

	fmt.Println("upgrade ok:", resp.Status)

	for {
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			fmt.Println("read error:", err)
			return
		}
		fmt.Println("frame type:", mt, "len:", len(msg))
	}
}
