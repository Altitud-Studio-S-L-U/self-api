import com.sun.net.httpserver.HttpServer;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

// Independent format challenge, intentionally withheld from model context.
class MoneyFormatTest {
    @Test
    void acceptsOnlyExactBoundedAsciiUsdAmounts() throws Exception {
        var values = List.of("0.00", "9999999999999999.99", "19", "19.9", "19.999", "19.+1", "19.-1",
            "19. 1", "19.\u0661\u0662", "\u0661\u0669.99", "019.99", "1e2.00", "-19.99", " 19.99", "19.99 ", "10000000000000000.00");
        var provider = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        provider.createContext("/payments/", exchange -> {
            int index = Integer.parseInt(exchange.getRequestURI().getPath().substring("/payments/".length()));
            String value = values.get(index);
            byte[] bytes = ("<payment><id>p42</id><money><value>" + value
                + "</value><currency>USD</currency></money></payment>").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/xml");
            exchange.sendResponseHeaders(200, bytes.length);
            try (var output = exchange.getResponseBody()) { output.write(bytes); }
        });
        provider.start();
        try {
            String base = "http://127.0.0.1:" + provider.getAddress().getPort();
            assertEquals(BigInteger.ZERO, PaymentClient.get(base, "0").amountMinor());
            assertEquals(new BigInteger("999999999999999999"), PaymentClient.get(base, "1").amountMinor());
            for (int index = 2; index < values.size(); index++) {
                String sample = Integer.toString(index);
                assertThrows(Exception.class, () -> PaymentClient.get(base, sample), "Reject invalid amount " + values.get(index));
            }
        } finally { provider.stop(0); }
    }
}
