import com.sun.net.httpserver.HttpServer;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;

// Identical tests are compiled against baseline and candidate adapters. No test is migrated.
public class PaymentTest {
    static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    public static void main(String[] args) throws Exception {
        String version = args[0];
        require(List.of("A", "B").contains(version), "Explicit fixture version required");
        HttpServer provider = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        provider.createContext("/payments/", exchange -> {
            String sample = exchange.getRequestURI().getPath().substring("/payments/".length());
            int status = sample.equals("rate") ? 429 : sample.equals("outage") ? 503 : 200;
            require("application/xml".equals(exchange.getRequestHeaders().getFirst("Accept")), "Native client must request XML");
            String amount = sample.equals("large") ? "90071992547409.93" : sample.equals("one") ? "0.01" : sample.equals("fraction") ? "19.999" : sample.equals("wrong-unit") ? "1999.00" : "19.99";
            String minor = sample.equals("large") ? "9007199254740993" : sample.equals("one") ? "1" : sample.equals("fraction") ? "1999.9" : sample.equals("wrong-unit") ? "199900" : "1999";
            String currency = sample.equals("currency") ? "JPY" : "USD";
            String body = "<payment><id>p42</id>" + (version.equals("A") ? "<amount_minor>" + minor + "</amount_minor><currency>" + currency + "</currency>" : "<money><value>" + amount + "</value><currency>" + currency + "</currency></money>") + "</payment>";
            if (sample.equals("oversized")) body = "x".repeat(65537);
            if (sample.equals("xxe")) body = "<!DOCTYPE payment [<!ENTITY leak SYSTEM 'file:///etc/passwd'>]><payment><id>&leak;</id></payment>";
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/xml");
            exchange.sendResponseHeaders(status, bytes.length);
            try (var stream = exchange.getResponseBody()) { stream.write(bytes); }
        });
        provider.start();
        String baseUrl = "http://127.0.0.1:" + provider.getAddress().getPort();
        try {
            for (String[] example : new String[][] {{"normal", "1999"}, {"one", "1"}, {"large", "9007199254740993"}}) {
                var payment = PaymentClient.get(baseUrl, example[0]);
                require(payment.id().equals("p42") && payment.currency().equals("USD") && payment.amountMinor().equals(new BigInteger(example[1])), "Internal monetary contract must remain exact");
            }
            require(!PaymentClient.get(baseUrl, "wrong-unit").amountMinor().equals(new BigInteger("1999")), "Incorrect units must not appear equivalent");
            for (String sample : List.of("fraction", "currency", "rate", "outage", "oversized", "xxe")) {
                boolean failed = false;
                try { PaymentClient.get(baseUrl, sample); } catch (Exception expected) { failed = true; }
                require(failed, "Invalid response must fail: " + sample);
            }
            System.out.println("Native Java HTTP/XML contract passed: 3 exact amounts, unit corruption, and 6 failure cases.");
        } finally { provider.stop(0); }
    }
}
