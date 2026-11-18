# JGit discovers Transport / HttpConnectionFactory implementations through ServiceLoader and
# touches optional JVM APIs (java.awt, javax.security) that do not exist on Android.
-keep class org.eclipse.jgit.** { *; }
-keep class com.jcraft.jsch.** { *; }
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**
-keep class org.slf4j.** { *; }
-dontwarn java.awt.**
-dontwarn javax.security.**
-dontwarn javax.naming.**
-dontwarn org.apache.**
-dontwarn org.eclipse.jgit.**
-dontwarn com.jcraft.jsch.**
