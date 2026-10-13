import org.junit.jupiter.api.Test;

// JUnit invokes the same loopback HTTP/XML contract harness in both immutable snapshots.
class PaymentContractTest {
    @Test
    void preservesThePaymentContractAndRejectsProviderFailures() throws Exception {
        PaymentTest.main(new String[] {"B"});
    }
}
