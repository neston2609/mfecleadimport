import java.io.*;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;

public class JdbcBridge {
  static String quote(String value) {
    if (value == null) return "null";
    StringBuilder out = new StringBuilder("\"");
    for (char c : value.toCharArray()) {
      if (c == '"' || c == '\\') out.append('\\').append(c);
      else if (c < 32) out.append(String.format("\\u%04x", (int)c));
      else out.append(c);
    }
    return out.append('"').toString();
  }
  static String strings(Collection<String> values) {
    return "[" + String.join(",", values.stream().map(JdbcBridge::quote).toList()) + "]";
  }
  public static void main(String[] args) {
    try {
      Properties input = new Properties();
      BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
      for (String line; (line = reader.readLine()) != null;) {
        int split = line.indexOf('=');
        if (split > 0) input.setProperty(line.substring(0, split), new String(Base64.getDecoder().decode(line.substring(split + 1)), StandardCharsets.UTF_8));
      }
      DriverManager.setLoginTimeout(10);
      String customDriver = input.getProperty("driverClass", "");
      if (!customDriver.isBlank()) {
        Class<?> driver = Class.forName(customDriver, false, JdbcBridge.class.getClassLoader());
        if (!Driver.class.isAssignableFrom(driver)) throw new SQLException("Configured class is not a JDBC driver");
        Class.forName(customDriver);
      }
      Properties credentials = new Properties();
      credentials.setProperty("user", input.getProperty("username", ""));
      credentials.setProperty("password", input.getProperty("password", ""));
      try (Connection connection = DriverManager.getConnection(input.getProperty("url"), credentials)) {
        try { connection.setReadOnly(true); } catch (SQLException ignored) { }
        connection.setAutoCommit(false);
        try { connection.setNetworkTimeout(Runnable::run, 20000); } catch (SQLException ignored) { }
        DatabaseMetaData metadata = connection.getMetaData();
        Map<String, String[]> tables = new TreeMap<>();
        try (ResultSet result = metadata.getTables(connection.getCatalog(), null, "%", new String[]{"TABLE", "VIEW"})) {
          while (result.next() && tables.size() < 1000) {
            String schema = result.getString("TABLE_SCHEM");
            String table = result.getString("TABLE_NAME");
            if (schema != null && (schema.equalsIgnoreCase("information_schema") || schema.equalsIgnoreCase("pg_catalog") || schema.equalsIgnoreCase("sys"))) continue;
            tables.put((schema == null || schema.isBlank() ? "" : schema + ".") + table, new String[]{schema, table});
          }
        }
        if (input.getProperty("action").equals("connect")) {
          System.out.print("{\"fields\":[],\"rows\":[],\"total\":0,\"truncated\":false,\"tables\":" + strings(tables.keySet()) + "}");
          connection.rollback(); return;
        }
        String query = input.getProperty("query", "");
        if (query.isBlank()) {
          String[] selected = tables.get(input.getProperty("table"));
          if (selected == null) throw new SQLException("Choose a table or enter a SELECT query");
          String identifierQuote = metadata.getIdentifierQuoteString().trim();
          if (identifierQuote.isEmpty()) throw new SQLException("Database cannot quote identifiers");
          String table = identifierQuote + selected[1].replace(identifierQuote, identifierQuote + identifierQuote) + identifierQuote;
          if (selected[0] != null && !selected[0].isBlank()) table = identifierQuote + selected[0].replace(identifierQuote, identifierQuote + identifierQuote) + identifierQuote + "." + table;
          query = "SELECT * FROM " + table;
        }
        int limit = Integer.parseInt(input.getProperty("limit", "10001"));
        try (Statement statement = connection.createStatement()) {
          statement.setQueryTimeout(20);
          statement.setMaxRows(limit);
          try (ResultSet result = statement.executeQuery(query)) {
            ResultSetMetaData columns = result.getMetaData();
            List<String> fields = new ArrayList<>();
            for (int i = 1; i <= columns.getColumnCount(); i++) {
              String field = columns.getColumnLabel(i);
              if (fields.contains(field)) throw new SQLException("Duplicate column labels; use SQL aliases");
              fields.add(field);
            }
            List<String> rows = new ArrayList<>();
            while (result.next()) {
              List<String> values = new ArrayList<>();
              for (int i = 1; i <= fields.size(); i++) values.add(quote(fields.get(i-1)) + ":" + quote(result.getString(i)));
              rows.add("{" + String.join(",", values) + "}");
            }
            System.out.print("{\"fields\":" + strings(fields) + ",\"rows\":[" + String.join(",", rows) + "],\"total\":" + rows.size() + ",\"truncated\":" + (rows.size() >= limit) + ",\"tables\":" + strings(tables.keySet()) + "}");
          }
        } finally { connection.rollback(); }
      }
    } catch (Exception error) {
      // Credentials and vendor error strings must never be returned or logged.
      System.err.println("JDBC connection or read query failed");
      System.exit(1);
    }
  }
}
