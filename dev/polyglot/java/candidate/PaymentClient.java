import java.io.*;
import java.math.BigInteger;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.*;

// Manually reviewed candidate fixture. Keepseam does not yet propose Java edits.
public class PaymentClient {
    public record Payment(String id, BigInteger amountMinor, String currency) {}

    public static Payment get(String baseUrl, String sample) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/payments/" + sample))
            .timeout(Duration.ofSeconds(3)).header("Accept", "application/xml").GET().build();
        try (HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build()) {
            HttpResponse<InputStream> response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
            try (InputStream stream = response.body()) {
                if (response.statusCode() != 200) throw new IOException("Unexpected HTTP status");
                byte[] raw = stream.readNBytes(65537);
                if (raw.length > 65536) throw new IOException("Oversized response");
                DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
                factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
                factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
                factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
                factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
                factory.setXIncludeAware(false);
                factory.setExpandEntityReferences(false);
                Element root = factory.newDocumentBuilder().parse(new ByteArrayInputStream(raw)).getDocumentElement();
                Element money = child(root, "money");
                String amount = text(money, "value"), currency = text(money, "currency");
                if (!amount.matches("(?:0|[1-9][0-9]{0,15})\\.[0-9]{2}") || !currency.equals("USD")) throw new IOException("Invalid internal payment");
                return new Payment(text(root, "id"), new BigDecimal(amount).movePointRight(2).toBigIntegerExact(), currency);
            }
        }
    }

    static String text(Element parent, String name) throws IOException {
        return child(parent, name).getTextContent();
    }
    static Element child(Element parent, String name) throws IOException {
        Element found = null;
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element element && element.getTagName().equals(name)) {
                if (found != null) throw new IOException("Duplicate " + name);
                found = element;
            }
        }
        if (found == null) throw new IOException("Expected " + name + " exactly once");
        return found;
    }
}
