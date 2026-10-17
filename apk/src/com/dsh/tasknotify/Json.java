package com.dsh.tasknotify;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Tiny dependency-free JSON reader/writer.
 *
 * <p>The APK deliberately avoids AndroidX and third-party runtime libraries so the
 * network path can also be compiled and exercised on a plain desktop JVM. This
 * class is the only JSON dependency of the receiver.</p>
 */
final class Json {
    static final class ParseException extends Exception {
        private static final long serialVersionUID = 1L;

        ParseException(String message) {
            super(message);
        }
    }

    private static final int MAX_DEPTH = 32;
    private static final int MAX_INPUT = 262144;

    private final String text;
    private int index;
    private int depth;

    private Json(String text) {
        this.text = text;
    }

    static Object parse(String text) throws ParseException {
        if (text == null) throw new ParseException("empty body");
        if (text.length() > MAX_INPUT) throw new ParseException("body too large");
        Json parser = new Json(text);
        parser.skipWhitespace();
        Object value = parser.readValue();
        parser.skipWhitespace();
        if (parser.index != text.length()) throw new ParseException("trailing characters at " + parser.index);
        return value;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value) {
        return value instanceof Map ? (Map<String, Object>) value : null;
    }

    @SuppressWarnings("unchecked")
    static List<Object> array(Object value) {
        return value instanceof List ? (List<Object>) value : null;
    }

    static String optString(Map<String, Object> map, String key, String fallback) {
        if (map == null) return fallback;
        Object value = map.get(key);
        return value instanceof String ? (String) value : fallback;
    }

    static long optLong(Map<String, Object> map, String key, long fallback) {
        if (map == null) return fallback;
        Object value = map.get(key);
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (!Double.isNaN(number) && !Double.isInfinite(number)) return (long) number;
        }
        if (value instanceof String) {
            try {
                return Long.parseLong(((String) value).trim());
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    static boolean optBoolean(Map<String, Object> map, String key, boolean fallback) {
        if (map == null) return fallback;
        Object value = map.get(key);
        return value instanceof Boolean ? (Boolean) value : fallback;
    }

    private Object readValue() throws ParseException {
        if (++depth > MAX_DEPTH) throw new ParseException("nesting too deep");
        try {
            skipWhitespace();
            if (index >= text.length()) throw new ParseException("unexpected end of input");
            char current = text.charAt(index);
            switch (current) {
                case '{':
                    return readObject();
                case '[':
                    return readArray();
                case '"':
                    return readString();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return null;
                default:
                    if (current == '-' || (current >= '0' && current <= '9')) return readNumber();
                    throw new ParseException("unexpected character '" + current + "' at " + index);
            }
        } finally {
            depth--;
        }
    }

    private Map<String, Object> readObject() throws ParseException {
        index++; // '{'
        Map<String, Object> result = new LinkedHashMap<>();
        skipWhitespace();
        if (peek() == '}') {
            index++;
            return result;
        }
        while (true) {
            skipWhitespace();
            if (peek() != '"') throw new ParseException("object key must be a string at " + index);
            String key = readString();
            skipWhitespace();
            if (peek() != ':') throw new ParseException("expected ':' at " + index);
            index++;
            result.put(key, readValue());
            skipWhitespace();
            char next = peek();
            if (next == ',') {
                index++;
                continue;
            }
            if (next == '}') {
                index++;
                return result;
            }
            throw new ParseException("expected ',' or '}' at " + index);
        }
    }

    private List<Object> readArray() throws ParseException {
        index++; // '['
        List<Object> result = new ArrayList<>();
        skipWhitespace();
        if (peek() == ']') {
            index++;
            return result;
        }
        while (true) {
            result.add(readValue());
            skipWhitespace();
            char next = peek();
            if (next == ',') {
                index++;
                continue;
            }
            if (next == ']') {
                index++;
                return result;
            }
            throw new ParseException("expected ',' or ']' at " + index);
        }
    }

    private String readString() throws ParseException {
        index++; // '"'
        StringBuilder out = new StringBuilder();
        while (index < text.length()) {
            char current = text.charAt(index++);
            if (current == '"') return out.toString();
            if (current == '\\') {
                if (index >= text.length()) throw new ParseException("unfinished escape");
                char escaped = text.charAt(index++);
                switch (escaped) {
                    case '"': out.append('"'); break;
                    case '\\': out.append('\\'); break;
                    case '/': out.append('/'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'u':
                        if (index + 4 > text.length()) throw new ParseException("unfinished unicode escape");
                        String hex = text.substring(index, index + 4);
                        index += 4;
                        try {
                            out.append((char) Integer.parseInt(hex, 16));
                        } catch (NumberFormatException error) {
                            throw new ParseException("bad unicode escape \\u" + hex);
                        }
                        break;
                    default:
                        throw new ParseException("bad escape \\" + escaped);
                }
                continue;
            }
            if (current < 0x20) throw new ParseException("control character in string at " + (index - 1));
            out.append(current);
        }
        throw new ParseException("unterminated string");
    }

    private Object readNumber() throws ParseException {
        int start = index;
        if (peek() == '-') index++;
        while (peek() >= '0' && peek() <= '9') index++;
        if (peek() == '.') {
            index++;
            while (peek() >= '0' && peek() <= '9') index++;
        }
        if (peek() == 'e' || peek() == 'E') {
            index++;
            if (peek() == '+' || peek() == '-') index++;
            while (peek() >= '0' && peek() <= '9') index++;
        }
        String token = text.substring(start, index);
        try {
            return Double.valueOf(token);
        } catch (NumberFormatException error) {
            throw new ParseException("bad number '" + token + "'");
        }
    }

    private void expect(String literal) throws ParseException {
        if (!text.startsWith(literal, index)) throw new ParseException("expected '" + literal + "' at " + index);
        index += literal.length();
    }

    private char peek() {
        return index < text.length() ? text.charAt(index) : '\0';
    }

    private void skipWhitespace() {
        while (index < text.length()) {
            char current = text.charAt(index);
            if (current == ' ' || current == '\t' || current == '\r' || current == '\n') index++;
            else break;
        }
    }

    /** Serialize a strict JSON value (maps, lists, strings, numbers, booleans, null). */
    static String stringify(Object value) {
        StringBuilder out = new StringBuilder();
        writeValue(out, value);
        return out.toString();
    }

    private static void writeValue(StringBuilder out, Object value) {
        if (value == null) {
            out.append("null");
            return;
        }
        if (value instanceof String) {
            writeString(out, (String) value);
            return;
        }
        if (value instanceof Boolean) {
            out.append(value.toString());
            return;
        }
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (Double.isNaN(number) || Double.isInfinite(number)) out.append("null");
            else if (number == Math.rint(number) && Math.abs(number) < 9.007199254740992E15) out.append((long) number);
            else out.append(value.toString());
            return;
        }
        if (value instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!first) out.append(',');
                first = false;
                writeString(out, String.valueOf(entry.getKey()));
                out.append(':');
                writeValue(out, entry.getValue());
            }
            out.append('}');
            return;
        }
        if (value instanceof Iterable) {
            out.append('[');
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) out.append(',');
                first = false;
                writeValue(out, item);
            }
            out.append(']');
            return;
        }
        writeString(out, String.valueOf(value));
    }

    private static void writeString(StringBuilder out, String value) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char current = value.charAt(i);
            switch (current) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (current < 0x20) {
                        out.append(String.format("\\u%04x", (int) current));
                    } else {
                        out.append(current);
                    }
            }
        }
        out.append('"');
    }
}
