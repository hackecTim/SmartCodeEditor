#include <stdio.h>
#include <string.h>

struct Point {
    int x;
    int y;
};

int sum(int a, int b) {
    return a + b;
}

int main(void) {
    struct Point p;
    p.x = 10;
    p.y = 20;

    printf("%d\n", sum(3, 4));
    printf("%d %d\n", p.x, p.y);
		
    return 0;
    
}
