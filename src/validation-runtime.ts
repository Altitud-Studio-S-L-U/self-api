import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { PlumberError } from './errors.js';

export type ValidationFramework = 'pytest' | 'maven-junit';
export interface ValidationRuntime {
  readonly schemaVersion: 1;
  readonly kind: ValidationFramework;
  readonly imageId: string;
  readonly recipeSha256: string;
  readonly dependenciesSha256: string;
}

export const PYTEST_ARTIFACTS = Object.freeze([
  { name: 'pytest', version: '9.1.1', url: 'https://files.pythonhosted.org/packages/24/25/1de2678b631f5a49215c6c96fff41ba892b0a34df68d6d80292b1b48aa7f/pytest-9.1.1-py3-none-any.whl', sha256: '37a86b45efb9a47a61a36449063e8e18d0cab3161329fc099eb21783169c4f0c' },
  { name: 'iniconfig', version: '2.3.1', url: 'https://files.pythonhosted.org/packages/56/43/4ca9e49d27a1fcf6bece6f6aec0ea46bb9112489b93d4b688fb415457bdb/iniconfig-2.3.1-py3-none-any.whl', sha256: '9121e2c1fdb355232495be3194c8dfe87ccc2d5dee45947b78e68f499790d7a7' },
  { name: 'packaging', version: '26.3', url: 'https://files.pythonhosted.org/packages/63/34/ba1c580383c9eada3711951fef0795c80b829a078d72188184bcab9dd527/packaging-26.3-py3-none-any.whl', sha256: 'd7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c' },
  { name: 'pluggy', version: '1.6.0', url: 'https://files.pythonhosted.org/packages/54/20/4d324d65cc6d9205fabedc306948156824eb9f0ee1633355a8f7ec5c66bf/pluggy-1.6.0-py3-none-any.whl', sha256: 'e920276dd6813095e9377c0bc5566d94c932c33b27a3e3945d8389c374dd4746' },
  { name: 'pygments', version: '2.21.0', url: 'https://files.pythonhosted.org/packages/71/46/17f022dd3e953bf20a04a028a21ec746d942f8d2af30fa0f124fa0e6a684/pygments-2.21.0-py3-none-any.whl', sha256: '2363c69b61c4a97c838da3b130dcd6468f4848992b21a82f2a63ec34377137d9' },
].map(value => Object.freeze(value)));
export const MAVEN_ARTIFACT = Object.freeze({ version: '3.9.16',
  url: 'https://downloads.apache.org/maven/maven-3/3.9.16/binaries/apache-maven-3.9.16-bin.tar.gz',
  sha512: '831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6',
});
export const MAVEN_COMPONENTS = Object.freeze({ junit: '6.1.3', compiler: '3.16.0', surefire: '3.6.0', resources: '3.5.0' });
export const MAVEN_FIXTURE_POM = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion><groupId>io.self-managed-api.validation</groupId><artifactId>consumer</artifactId><version>1.0</version>
  <properties><maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
  <dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>${MAVEN_COMPONENTS.junit}</version><scope>test</scope></dependency></dependencies>
  <build><plugins>
    <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>${MAVEN_COMPONENTS.resources}</version></plugin>
    <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>${MAVEN_COMPONENTS.compiler}</version></plugin>
    <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>${MAVEN_COMPONENTS.surefire}</version></plugin>
  </plugins></build>
</project>\n`;
export const MAVEN_REPORT_CHECK = `import java.nio.file.*;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.XMLConstants;
public final class SelfManagedApiReports {
  public static void main(String[] args) throws Exception {
    var factory = DocumentBuilderFactory.newInstance();
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
    factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
    factory.setXIncludeAware(false);
    factory.setExpandEntityReferences(false);
    for (var selected : args[1].split(",")) {
      var report = Path.of(args[0], "TEST-" + selected + ".xml");
      if (!Files.isRegularFile(report, LinkOption.NOFOLLOW_LINKS) || Files.size(report) > 2 * 1024 * 1024)
        throw new IllegalStateException("Every selected JUnit class must produce a bounded report");
      var root = factory.newDocumentBuilder().parse(report.toFile()).getDocumentElement();
      if (!root.getTagName().equals("testsuite") || !root.getAttribute("name").equals(selected))
        throw new IllegalStateException("Selected JUnit class does not match its report");
      int executed = 0;
      var cases = root.getElementsByTagName("testcase");
      for (int i = 0; i < cases.getLength(); i++) {
        var test = (org.w3c.dom.Element) cases.item(i);
        if (test.getElementsByTagName("failure").getLength() > 0 || test.getElementsByTagName("error").getLength() > 0)
          throw new IllegalStateException("JUnit reported a failed test");
        if (test.getElementsByTagName("skipped").getLength() == 0) executed++;
      }
      if (executed == 0) throw new IllegalStateException("Every selected JUnit class must execute a test");
    }
    System.out.println("SELF_MANAGED_API_JUNIT_EXECUTED");
  }
}\n`;
export const FRAMEWORK_BASE_IMAGES = Object.freeze({
  pytest: 'python@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a',
  'maven-junit': 'eclipse-temurin@sha256:51ae87bbb1949c1afdff51f6a3e6c5f283d84a4bd68512c9657fdc6605026a49',
});
export function runtimeRecipe(kind: ValidationFramework) {
  return { schemaVersion: 1, kind, baseImage: FRAMEWORK_BASE_IMAGES[kind], platform: 'linux/amd64',
    dependencies: kind === 'pytest' ? PYTEST_ARTIFACTS : { maven: MAVEN_ARTIFACT, components: MAVEN_COMPONENTS,
      pomSha256: createHash('sha256').update(MAVEN_FIXTURE_POM).digest('hex'),
      reportCheckSha256: createHash('sha256').update(MAVEN_REPORT_CHECK).digest('hex') },
    preparation: kind === 'pytest' ? 'verified-wheels-no-index' : 'fixed-junit-fixture-strict-checksums',
    execution: 'offline-captured-source-only' };
}
export function runtimeRecipeSha256(kind: ValidationFramework): string {
  return createHash('sha256').update(JSON.stringify(runtimeRecipe(kind))).digest('hex');
}
export function validateRuntime(input: unknown): ValidationRuntime {
  if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'dependenciesSha256,imageId,kind,recipeSha256,schemaVersion'
    || value.schemaVersion !== 1 || (value.kind !== 'pytest' && value.kind !== 'maven-junit')
    || typeof value.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.imageId)
    || value.recipeSha256 !== runtimeRecipeSha256(value.kind)
    || typeof value.dependenciesSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.dependenciesSha256)) invalid();
  return Object.freeze({ schemaVersion: 1, kind: value.kind, imageId: value.imageId,
    recipeSha256: value.recipeSha256, dependenciesSha256: value.dependenciesSha256 });
}
function invalid(): never { throw new PlumberError('INVALID_INPUT', 'Use a prepared validation runtime manifest with its immutable image, known recipe and dependency digest.'); }
